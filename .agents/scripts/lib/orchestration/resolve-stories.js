/**
 * lib/orchestration/resolve-stories.js — resolve a set of Story ids into the
 * `{ stories, dag, done }` envelope the delivery scheduler consumes.
 *
 * This is the ONE resolution step for `/deliver`. It generalizes the
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
import { resolveStoryDispatchMode } from './complexity-gate.js';

/** Labels/state that mean a blocker no longer gates its dependents. */
const DONE_LABEL = 'agent::done';

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
 * @returns {{ id, title, body, url, labels, state, assignees }}
 */
export function toStoryRecord(issue, requestedId) {
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
        `/deliver accepts ${TYPE_LABELS.STORY} tickets only — close it or re-plan it as a v2 Story.`,
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
 * Build the DAG nodes. `dependsOn` is the union the adjacency builder already
 * computes (body-parsed `blocked by #N` + explicit fields), plus any native
 * edges threaded in via `nativeEdges`. `files` is a plain `string[]`.
 *
 * @param {object[]} stories
 * @param {Map<number, number[]>} [nativeEdges]
 * @param {(msg: string) => void} [warn]
 * @returns {{ id: number, dependsOn: number[], files: string[] }[]}
 */
export function storiesToDag(stories, nativeEdges = new Map(), warn) {
  const withNative = stories.map((s) => ({
    ...s,
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
 * Cross-repo blockers are rejected rather than matched: another repo's #4530
 * is not this repo's #4530, and treating it as one could satisfy a gate that
 * is still open.
 *
 * @param {unknown} data Parsed API response.
 * @param {{ owner: string, repo: string, issueNumber: number }} ctx
 * @returns {number[]}
 */
export function nativeBlockedByNumbers(data, { owner, repo, issueNumber }) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const item of data) {
    const repoUrl = item?.repository_url ?? item?.repository?.url ?? null;
    if (typeof repoUrl === 'string' && repoUrl.length > 0) {
      const expected = `/repos/${owner}/${repo}`;
      if (!repoUrl.endsWith(expected)) {
        throw new Error(
          `[resolve-stories] #${issueNumber} is blocked by an issue in another repository ` +
            `(${repoUrl}). Cross-repo dependency edges are not supported — its number cannot ` +
            `be matched against this repo's Stories without risking a false match.`,
        );
      }
    }
    const number = Number(item?.number);
    if (Number.isInteger(number) && number > 0) out.push(number);
  }
  return [...new Set(out)];
}

/**
 * Read an issue's native `blocked_by` edges as issue numbers.
 *
 * **Fails loud**, deliberately inverting the write path's non-fatal contract.
 * A dropped write-side edge is cosmetic (the ordering still lives in the
 * `blocked by #N` body footer); a dropped READ-side edge silently removes a
 * dispatch gate, so a 403 (dependencies API disabled, or a token without the
 * scope) would erase every native edge at once and co-dispatch the whole run
 * against unlanded blockers. A 404 means "no dependencies on this issue" and
 * is a legitimate empty result.
 *
 * @param {{ gh: object, owner: string, repo: string, issueNumber: number, parseJson: Function }} opts
 * @returns {Promise<number[]>}
 */
export async function readNativeBlockedBy({
  gh,
  owner,
  repo,
  issueNumber,
  parseJson,
}) {
  let result;
  try {
    result = await gh.api({
      method: 'GET',
      endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
    });
  } catch (err) {
    const detail = String(err?.message ?? err);
    if (/404|not found/i.test(detail)) return [];
    throw new Error(
      `[resolve-stories] Could not read native blocked_by edges for #${issueNumber}: ${detail}. ` +
        `Refusing to continue: a dropped dependency edge would silently remove a dispatch gate ` +
        `and co-dispatch this Story against an unlanded blocker.`,
    );
  }
  return nativeBlockedByNumbers(parseJson(result), {
    owner,
    repo,
    issueNumber,
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
  config,
}) {
  const sorted = [...stories].sort((a, b) => a.id - b.id);
  const inSetDone = sorted.filter(isSatisfiedBlocker).map((s) => s.id);
  return {
    kind: 'stories',
    // `dispatchMode` (Story #4722): the resolver derives the per-Story
    // execution mode from the fetched Story BODY's own shape (the shared
    // shape function in `complexity-gate.js`) so `/deliver` reads one field —
    // `inline` (lite-shaped: no story-worker / acceptance-critic sub-agent
    // boots) or `subagent` (everything else, the conservative default). The
    // `route::lite` label is a human-visible hint only, never the control
    // signal: a lost label cannot misroute delivery. Model-side fan-out
    // only; close gates are untouched.
    stories: sorted.map(({ id, title, body, url, labels, state }) => ({
      id,
      title,
      url,
      labels,
      state,
      dispatchMode: resolveStoryDispatchMode({ body, labels, config }).mode,
    })),
    dag: storiesToDag(sorted, nativeEdges, warn),
    done: [...new Set([...inSetDone, ...foreignDone])].sort((a, b) => a - b),
  };
}

/**
 * Parse and validate the `--ids` list.
 *
 * @param {string|undefined} raw
 * @returns {number[]}
 */
export function parseIds(raw) {
  const ids = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number.parseInt(s, 10);
      if (!Number.isInteger(n) || n <= 0 || String(n) !== s) {
        throw new Error(
          `[resolve-stories] --ids must be a comma-separated list of positive issue numbers (got "${s}").`,
        );
      }
      return n;
    });
  if (ids.length === 0) {
    throw new Error(
      '[resolve-stories] --ids is required: node resolve-stories.js --ids 101,102',
    );
  }
  return [...new Set(ids)];
}
