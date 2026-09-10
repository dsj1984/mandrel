/**
 * lib/orchestration/resolve-stories.js — resolve a set of Story ids into the
 * `{ stories, dag, done }` envelope the delivery scheduler consumes.
 *
 * This is the ONE resolution step for `/mandrel-deliver`. It generalizes the
 * envelope shaping proven by the retired `resolve-plan-run.js` and fixes the
 * two defects that shipped with it:
 *
 *   - it fetched with `state: 'open'`, so an already-landed sibling vanished
 *     from the envelope and `done[]` could never be populated;
 *   - `done[]` was computed only over label-fetched issues, so a dependency
 *     outside the fetched set could never be satisfied.
 *
 * Both made cross-run, over-time delivery structurally impossible. Here every
 * dependency — in-set or foreign — is resolved against live issue state, so a
 * Story whose blocker landed weeks ago in another plan run is simply ready.
 *
 * Two contracts differ deliberately from the label-scoped ancestor:
 *
 *   1. **Id-scoped fetch means a named non-Story is an ERROR, not a filter.**
 *      `toStoryRecord` used to return `null` for a non-Story, which is right
 *      when a label query returns incidental noise and wrong when an operator
 *      names an id explicitly: silently dropping it yields a partial envelope
 *      that under-delivers without saying so.
 *   2. **The native-edge read fails loud.** See {@link readNativeBlockedBy}.
 *
 * @module lib/orchestration/resolve-stories
 */

import { extractEpicIdFromBody, parseBlockedBy } from '../dependency-parser.js';
import { TYPE_LABELS } from '../label-constants.js';
import { buildStoryAdjacency } from '../story-adjacency.js';
import {
  extractChangePaths,
  parse as parseStoryBody,
} from '../story-body/story-body.js';
import { expandIdList } from '../util/parse-id-list.js';
import { resolveStoryDispatchMode } from './complexity-gate.js';

/** Labels/state that mean a blocker no longer gates its dependents. */
const DONE_LABEL = 'agent::done';

/**
 * The lifecycle-label prefix a deliverable Story carries. Any `agent::*` label
 * will do — the resolver is not a state machine and does not care WHICH state a
 * Story is in, only that it has been through the step that assigns one.
 */
const AGENT_LABEL_PREFIX = 'agent::';

/**
 * Module-private: `toStoryRecord` and `isSatisfiedBlocker` are its only
 * callers. The ancestor exported it with no external consumer, which is how
 * a symbol ends up baselined as a dead export.
 *
 * @param {object} issue
 * @returns {string[]}
 */
function normalizeIssueLabels(issue) {
  const raw = issue?.labels;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n.length > 0);
}

/**
 * Map one fetched issue into a Story record, or throw naming the id and the
 * remedy. Unlike the label-scoped ancestor this **never** returns `null`:
 * under `--ids` the operator named this issue, so dropping it silently would
 * emit a partial envelope.
 *
 * @param {object} issue
 * @param {number} [requestedId] The id the operator asked for, for error text.
 * @param {{ allowUnlabelled?: boolean }} [options] `allowUnlabelled` waives the
 *   `agent::*` guard below — the deliberate escape hatch for delivering a Story
 *   whose state label is absent for a reason the operator knows about.
 * @returns {{ id, title, body, url, labels, state, assignees }}
 */
export function toStoryRecord(issue, requestedId, { allowUnlabelled } = {}) {
  const id = Number(issue?.number ?? issue?.id ?? requestedId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[resolve-stories] #${requestedId ?? '?'} did not resolve to an issue number.`,
    );
  }
  const labels = normalizeIssueLabels(issue);
  if (!labels.includes(TYPE_LABELS.STORY)) {
    throw new Error(
      `[resolve-stories] Issue #${id} is not a Story (labels: ${labels.join(', ') || 'none'}). ` +
        `/mandrel-deliver accepts ${TYPE_LABELS.STORY} tickets only — close it or re-plan it as a v2 Story.`,
    );
  }
  const body = String(issue?.body ?? '');
  const epicId = extractEpicIdFromBody(body);
  if (epicId !== null) {
    throw new Error(
      `[resolve-stories] Issue #${id} still carries an "Epic: #${epicId}" footer. ` +
        `v2 is Story-only — re-plan it as a v2 Story or finish it on a pre-v2 checkout.`,
    );
  }
  // Last, so the two shape refusals above — not a Story at all, and a v1 body —
  // keep naming their own remedy rather than being masked by a missing label.
  assertDispatchable(id, labels, allowUnlabelled);
  return {
    id,
    title: String(issue?.title ?? ''),
    body,
    url: issue?.html_url ?? issue?.url ?? null,
    labels,
    state: String(issue?.state ?? 'open').toLowerCase(),
    // The assignee list carries the Story lease (`ticket-lease.js`): its sole
    // assignee is the operator that owns the in-flight run. The probe reads it
    // to withhold a Story another operator holds (`live-probe.js`), so it is
    // threaded onto the record here rather than dropped. `issueToTicket`
    // already reduces assignees to bare login strings; keep only those.
    assignees: Array.isArray(issue?.assignees)
      ? issue.assignees.filter((a) => typeof a === 'string' && a.length > 0)
      : [],
  };
}

/**
 * Refuse a Story that has never been through planning.
 *
 * The audit sweep files Stories deliberately WITHOUT an `agent::*` label: their
 * bodies are audit prose — a symptom and a recommendation — not a scoped change
 * with acceptance criteria a worker can verify against, and the sweep's runbook
 * says so. But `/mandrel-deliver` takes ids, and nothing downstream re-checked the
 * label, so naming a freshly-filed audit Story dispatched a worker at an
 * unenriched body: the run then either invented its own acceptance criteria or
 * blocked several minutes in, having taken the Story's lease and flipped it to
 * `agent::executing` on the way.
 *
 * The label is the cheap, honest signal that the enrich step ran — no state
 * machine is consulted, only that SOME `agent::*` label exists.
 *
 * @param {number} id
 * @param {string[]} labels
 * @param {boolean} [allowUnlabelled]
 */
function assertDispatchable(id, labels, allowUnlabelled) {
  if (allowUnlabelled) return;
  if (labels.some((l) => l.startsWith(AGENT_LABEL_PREFIX))) return;
  throw new Error(
    `[resolve-stories] Issue #${id} carries no "${AGENT_LABEL_PREFIX}*" label, so it has not been ` +
      `through planning — an audit sweep files Stories without one on purpose (its runbook's ` +
      `"Enrich before you deliver" step). Route it through /mandrel-plan first, which applies ` +
      `agent::ready once the finding is a scoped slice. Pass --allow-unlabelled to deliver it as-is.`,
  );
}

/**
 * A blocker stops gating once its issue is closed or carries `agent::done`.
 *
 * @param {{ state?: string, labels?: string[] }} issue
 * @returns {boolean}
 */
export function isSatisfiedBlocker(issue) {
  const state = String(issue?.state ?? '').toLowerCase();
  if (state === 'closed') return true;
  return normalizeIssueLabels(issue).includes(DONE_LABEL);
}

/**
 * Footprint emitted when a Story's declared changes cannot be READ. It is a
 * glob, so `storiesOverlap` (`lib/wave-runner/ready-set.js`) treats it as
 * overlapping every other **declared** footprint and the Story takes its
 * beat alone. (A Story declaring nothing still overlaps nothing — the guard
 * short-circuits on an empty footprint either side, which is the deliberate
 * permissive escape hatch that keeps undeclared work parallel.)
 *
 * Deliberately NOT `[]`. An empty footprint means "declares nothing", which
 * the guard reads as "overlaps nothing" and never withholds — correct for a
 * Story that genuinely declares no changes, and wrong for one whose changes
 * we failed to parse. Those are different facts: the second is *unknown*
 * width, and the same argument that makes a glob overlap everything
 * ("unknown width is not no width") applies to a body we could not read.
 */
const UNKNOWN_FOOTPRINT = Object.freeze(['**']);

/**
 * Extract a Story's declared file footprint as **plain path strings**.
 *
 * The shape matters: `stories-wave-tick.js`'s `parseDag` rejects any `files`
 * entry that is not a string, while `extractChangePaths` returns
 * `{ path, isGlob }` objects — so forwarding its output verbatim fails every
 * multi-Story run with an input error. Map to `.path`.
 *
 * Never throws — these are live, human-editable issue bodies, and one
 * malformed body must not take the whole resolution down. It fails **safe**
 * rather than open: an unreadable footprint yields {@link UNKNOWN_FOOTPRINT},
 * serializing that Story instead of silently letting it race.
 *
 * @param {string} body
 * @param {number} [id] Story id, for the warning.
 * @param {(msg: string) => void} [warn]
 * @returns {string[]}
 */
export function storyFootprintPaths(body, id, warn) {
  let parsed;
  try {
    parsed = parseStoryBody(String(body ?? '')).body;
  } catch (err) {
    warn?.(
      `[resolve-stories] #${id}: body is unparseable, so its file footprint is unknown ` +
        `(${err?.message ?? err}). Treating it as overlapping every other Story, so it is ` +
        `never co-dispatched — fix the body to restore parallelism.`,
    );
    return [...UNKNOWN_FOOTPRINT];
  }
  try {
    // An empty `changes` is a real declaration of "no files", not a read
    // failure — it keeps the permissive empty footprint.
    return extractChangePaths(parsed?.changes ?? [])
      .map((entry) => entry?.path)
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());
  } catch (err) {
    warn?.(
      `[resolve-stories] #${id}: malformed changes entry, so its file footprint is unknown ` +
        `(${err?.message ?? err}). Treating it as overlapping every other Story.`,
    );
    return [...UNKNOWN_FOOTPRINT];
  }
}

/**
 * Build the DAG nodes. `dependsOn` is the **union of the two declared-edge
 * channels**: the Story body's `---` footer (`blocked by #N`) and the native
 * GitHub `blocked_by` relations threaded in via `nativeEdges`. `files` is a
 * plain `string[]`.
 *
 * The body channel is footer-scoped and strict (`parseBlockedBy`, Story
 * #5046) — a `blocked by #123` mention in prose no longer mints a dispatch
 * gate. Only `{ id, dependsOn }` is handed to the adjacency builder, never the
 * body: the edge set is decided here, once, so the builder's own body parse
 * cannot re-derive a different one behind this function's back.
 *
 * @param {object[]} stories
 * @param {Map<number, number[]>} [nativeEdges]
 * @param {(msg: string) => void} [warn]
 * @returns {{ id: number, dependsOn: number[], files: string[] }[]}
 */
export function storiesToDag(stories, nativeEdges = new Map(), warn) {
  const withNative = stories.map((s) => ({
    id: s.id,
    dependsOn: [
      ...new Set([
        ...parseBlockedBy(s.body ?? ''),
        ...(nativeEdges.get(s.id) ?? []),
      ]),
    ],
  }));
  // dropForeign:false — a dependency outside the requested set is a real
  // gate, not noise. What changes here is that such a gate is now
  // *satisfiable*: `done[]` carries foreign blockers resolved from live state.
  const adjacency = buildStoryAdjacency(withNative, { dropForeign: false });
  return stories.map((s) => ({
    id: s.id,
    dependsOn: adjacency.get(s.id) ?? [],
    files: storyFootprintPaths(s.body, s.id, warn),
  }));
}

/**
 * Project the dependencies API response onto issue **numbers**.
 *
 * The API returns both `id` (database id) and `number` (issue number); the
 * write path (`providers/github/blocked-by-add.js`) reads `id` because its
 * POST body needs `issue_id`. Reusing that projection here would build
 * `dependsOn: [4902374986]` for a blocker whose issue number is 4530 — an id
 * matching no Story, foreign to the set, never satisfiable, and (because
 * foreign edges are real gates) a silent permanent wedge.
 *
 * A cross-repo blocker is **dropped with a loud warning**, never matched:
 * another repo's #4530 is not this repo's #4530, and treating it as one could
 * satisfy a gate that is still open. It used to throw, which failed the WHOLE
 * resolution — one Story's unsupported edge took every sibling down with it
 * (Story #5046). The degrade is now scoped to the Story carrying the edge:
 * its siblings resolve normally, and the operator is told, by number, which
 * Story lost which edge.
 *
 * @param {unknown} data Parsed API response.
 * @param {{ owner: string, repo: string, issueNumber: number, warn?: (msg: string) => void }} ctx
 * @returns {number[]}
 */
export function nativeBlockedByNumbers(
  data,
  { owner, repo, issueNumber, warn },
) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const item of data) {
    const repoUrl = item?.repository_url ?? item?.repository?.url ?? null;
    if (
      typeof repoUrl === 'string' &&
      repoUrl.length > 0 &&
      !repoUrl.endsWith(`/repos/${owner}/${repo}`)
    ) {
      warn?.(
        `[resolve-stories] #${issueNumber} declares a native blocked_by edge on an issue in ` +
          `another repository (${repoUrl}). Cross-repo edges are not supported — its number ` +
          `cannot be matched against this repo's Stories without risking a false match, so the ` +
          `edge is DROPPED for #${issueNumber} only. Its siblings resolve normally; re-declare ` +
          `the ordering in this repo if #${issueNumber} must wait.`,
      );
      continue;
    }
    const number = Number(item?.number);
    if (Number.isInteger(number) && number > 0) out.push(number);
  }
  return [...new Set(out)];
}

/**
 * Read an issue's native `blocked_by` edges as issue numbers, **paginated to
 * exhaustion**.
 *
 * The read used to take the first page only, so a Story with more than a
 * page of blockers silently lost every edge past the boundary — the exact
 * failure this function's fail-loud contract exists to prevent, arriving
 * through the one door that never raised (Story #5046). `paginate` is
 * injected (the CLI passes `paginateRest`) so the lib layer stays free of a
 * provider import and the page walk stays testable without a live round-trip.
 *
 * **Fails loud on every non-OK read**, deliberately inverting the write path's
 * non-fatal contract. A dropped write-side edge is cosmetic (the ordering
 * still lives in the `blocked by #N` body footer); a dropped READ-side edge
 * silently removes a dispatch gate, so one failure would erase every native
 * edge at once and co-dispatch the run against unlanded blockers.
 *
 * **A 404 is not an empty result.** It used to be treated as "this issue has
 * no dependencies", which is how GitHub answers an issue that genuinely has
 * none — but it is *also* how GitHub answers a token that cannot see the
 * dependencies API at all. Reading the second as the first erases every
 * native edge in the run under a mis-scoped token, silently, with a clean
 * exit code. An issue with no dependencies returns `200 []`, so the empty
 * case needs no 404 escape hatch and the ambiguity resolves loud.
 *
 * @param {{ gh: object, owner: string, repo: string, issueNumber: number,
 *   paginate: (gh: object, endpoint: string, opts?: object) => Promise<unknown[]>,
 *   warn?: (msg: string) => void }} opts
 * @returns {Promise<number[]>}
 */
export async function readNativeBlockedBy({
  gh,
  owner,
  repo,
  issueNumber,
  paginate,
  warn,
}) {
  const endpoint = `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`;
  let items;
  try {
    items = await paginate(gh, endpoint, {
      label: `[resolve-stories] blocked_by #${issueNumber}`,
    });
  } catch (err) {
    const detail = String(err?.message ?? err);
    throw new Error(
      `[resolve-stories] Could not read native blocked_by edges for #${issueNumber}: ${detail}. ` +
        `Refusing to continue: a dropped dependency edge would silently remove a dispatch gate ` +
        `and co-dispatch this Story against an unlanded blocker. A 404 here is NOT "no ` +
        `dependencies" (that answers 200 with an empty list) — check the token's scopes and ` +
        `that the dependencies API is enabled for ${owner}/${repo}.`,
    );
  }
  return nativeBlockedByNumbers(items, {
    owner,
    repo,
    issueNumber,
    warn,
  });
}

/**
 * Assemble the envelope from resolved records.
 *
 * @param {object[]} stories
 * @param {Map<number, number[]>} nativeEdges
 * @param {number[]} foreignDone Ids outside the set already satisfied.
 * @param {(msg: string) => void} [warn]
 * @returns {{ kind: string, stories: object[], dag: object[], done: number[] }}
 */
export function buildStoriesEnvelope({
  stories,
  nativeEdges = new Map(),
  foreignDone = [],
  warn,
}) {
  const sorted = [...stories].sort((a, b) => a.id - b.id);
  const inSetDone = sorted.filter(isSatisfiedBlocker).map((s) => s.id);
  return {
    kind: 'stories',
    // `dispatchMode` (Story #4722, #4736, #4829): the resolver reports the
    // per-Story execution mode so `/mandrel-deliver` reads one field — `inline` (run
    // deliver-story in the router's own session: no story-worker /
    // acceptance-critic sub-agent boots) or `subagent` (the conservative
    // default). Model-side fan-out only; close gates are untouched.
    //
    // `storyCount` is the ONLY premise that decides it, and it is this call
    // site's whole argument: `inline` names the router's ONE session, so it is
    // granted only to a run resolving exactly ONE Story, which has no
    // concurrent sibling to share that session with. Passing the resolved set
    // size here is therefore what makes the envelope self-consistent with the
    // ready set `stories-wave-tick.js` computes from the same `dag`: a set of
    // more than one can never come back with a Story claiming the session
    // (Story #4829 — it previously could, whenever the body was lite-shaped).
    // It is the resolved set size, NOT the undelivered remainder, so the mode
    // a caller reads for a given `--ids` list never changes as siblings land
    // mid-run. The `route::lite` label is a human-visible hint only, never the
    // control signal.
    stories: sorted.map(({ id, title, url, labels, state }) => ({
      id,
      title,
      url,
      labels,
      state,
      dispatchMode: resolveStoryDispatchMode({ storyCount: sorted.length })
        .mode,
    })),
    dag: storiesToDag(sorted, nativeEdges, warn),
    done: [...new Set([...inSetDone, ...foreignDone])].sort((a, b) => a - b),
  };
}

/**
 * Parse and validate the `--ids` list, expanding any `A-B` dash range.
 *
 * A contiguous span is how an operator names a plan run — `/mandrel-deliver 4922 -
 * 4926` — so the range is expanded here rather than transcribed by the host.
 * `stories-wave-tick.js --stories` reads through this same function, which is
 * what keeps the sequencing set identical to the resolved one.
 *
 * @param {string|undefined} raw
 * @param {string} [flag] Flag name, for the error message.
 * @returns {number[]}
 */
export function parseIds(raw, flag = '--ids') {
  const { ids, error } = expandIdList(raw, {
    flag,
    prefix: '[resolve-stories] ',
  });
  if (error) {
    throw new Error(error);
  }
  if (ids.length === 0) {
    throw new Error(
      `[resolve-stories] ${flag} is required: node resolve-stories.js --ids 101,102 (or a range: --ids 101-104)`,
    );
  }
  return ids;
}
