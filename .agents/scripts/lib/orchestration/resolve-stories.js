/**
 * lib/orchestration/resolve-stories.js — resolve Story ids into the
 * `{ stories, dag, done }` delivery envelope. Every dependency resolves
 * against live state, so a long-landed foreign blocker is satisfied.
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

const DONE_LABEL = 'agent::done';

/** Any `agent::*` label proves the Story has been through planning. */
const AGENT_LABEL_PREFIX = 'agent::';

/**
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
 * remedy — never `null`, since the operator named this issue.
 *
 * @param {object} issue
 * @param {number} [requestedId] The id the operator asked for, for error text.
 * @param {{ allowUnlabelled?: boolean }} [options] `allowUnlabelled` waives the
 *   `agent::*` guard (deliberate escape hatch).
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
  // Last, so the shape refusals above keep naming their own remedy.
  assertDispatchable(id, labels, allowUnlabelled);
  return {
    id,
    title: String(issue?.title ?? ''),
    body,
    url: issue?.html_url ?? issue?.url ?? null,
    labels,
    state: String(issue?.state ?? 'open').toLowerCase(),
    // The sole assignee is the Story lease holder; the live probe reads it to
    // withhold a Story another operator holds.
    assignees: Array.isArray(issue?.assignees)
      ? issue.assignees.filter((a) => typeof a === 'string' && a.length > 0)
      : [],
  };
}

/**
 * Refuse an unplanned Story (audit sweeps file them unlabelled on purpose).
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
 * A blocker stops gating once closed or labelled `agent::done`.
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
 * Footprint for a Story whose changes could not be READ: a glob, so the
 * overlap guard serializes it against every declared footprint. Not `[]` —
 * empty means "declares nothing" and never withholds; unknown width is not
 * no width.
 */
const UNKNOWN_FOOTPRINT = Object.freeze(['**']);

/**
 * A Story's declared footprint as plain path strings (`parseDag` rejects the
 * `{ path, isGlob }` objects `extractChangePaths` returns). Never throws on a
 * malformed body; fails safe to {@link UNKNOWN_FOOTPRINT}.
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
    // An empty `changes` is a real "no files" declaration, not a read failure.
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
 * DAG nodes. `dependsOn` is the union of the body footer's strict
 * `blocked by` edges and the native `blocked_by` relations. Only
 * `{ id, dependsOn }` reaches the adjacency builder, so it cannot re-derive a
 * different edge set from the body.
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
  // A foreign dependency is a real gate, satisfiable via `done[]`.
  const adjacency = buildStoryAdjacency(withNative, { dropForeign: false });
  return stories.map((s) => ({
    id: s.id,
    dependsOn: adjacency.get(s.id) ?? [],
    files: storyFootprintPaths(s.body, s.id, warn),
  }));
}

/**
 * Issue NUMBERS, not database `id`s (which match no Story and wedge the gate).
 * A cross-repo blocker is dropped with a warning, scoped to its Story.
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
 * Paginated to exhaustion; fails loud, since a dropped edge silently removes
 * a gate. A 404 is NOT "no dependencies" (that is `200 []`) — it can mean a
 * token that cannot see the API.
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
    // `inline` (the router's own session) only for a single-Story set, so no
    // sibling can claim that session. Decided on the resolved set size, not
    // the undelivered remainder, so the mode never changes mid-run.
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
 * Expands `A-B` ranges; shared with `stories-wave-tick.js --stories`.
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
