/**
 * epic-run-state-store — stateless functions for reading and writing the
 * `epic-run-state` structured comment used by `/deliver`.
 *
 * Story #4155 (Epic #4151) — the Epic `/deliver` runtime cut over from
 * the wave-batch scheduler to the continuous ready-set core
 * (`lib/wave-runner/ready-set.js`). The checkpoint shrank with it: it no
 * longer carries `currentWave`, `plan[][]`, `totalWaves`, or the
 * per-wave `waves[]` aggregation. The durable run state is now a flat
 * **per-Story status map** (`stories: { [storyId]: { status, title?,
 * blockerCommentId? } }`) plus the run-level `concurrencyCap` (the
 * GLOBAL in-flight cap the ready-set selector honours), `phase`,
 * `startedAt`, and `manualInterventions[]`. There is no resume-pointer
 * to reconcile — the ready-set core re-derives adjacency and readiness
 * from live Story bodies/labels on every tick, so the checkpoint only
 * records terminal Story outcomes (for the auto-merge predicate, branch
 * cleanup, and the operator rollup) and the run-level knobs.
 *
 * This module is the function-based replacement for the legacy
 * `Checkpointer` class that previously lived at
 * `./epic-runner/checkpointer.js`. Story #2423 (Epic #2307) deleted the
 * class file; the class API survives as a tests-only fixture at
 * `tests/fixtures/epic-run-state-store.js`.
 *
 * The comment is identified by a stable HTML marker so it can be overwritten
 * idempotently across orchestrator restarts. The body is a fenced JSON block.
 */

import { assertValidDeliverPhase } from './epic-runner/deliver-phases.js';
import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, upsertStructuredComment } from './ticketing.js';

export const EPIC_RUN_STATE_TYPE = 'epic-run-state';
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** Terminal / in-progress per-Story statuses persisted on the checkpoint. */
export const STORY_STATUSES = Object.freeze([
  'pending',
  'done',
  'blocked',
  'failed',
]);

// Re-export the phase enum + index helper so downstream importers continue
// to use this module as a single import target.
export {
  DELIVER_PHASES,
  phaseIndex,
} from './epic-runner/deliver-phases.js';

function assertProvider(provider) {
  if (!provider)
    throw new TypeError('epic-run-state-store requires a provider');
}

function assertEpicId(epicId) {
  if (!Number.isInteger(epicId)) {
    throw new TypeError('epic-run-state-store requires a numeric epicId');
  }
}

/**
 * Normalize an inbound Story id (accepts the ticket `id` shape, the raw
 * GitHub `number` shape, and a bare integer) to a positive integer, or
 * `null` when it is absent / non-positive / non-integer.
 *
 * @param {object|number|string} entry
 * @returns {number|null}
 */
function storyIdOf(entry) {
  if (typeof entry === 'number') {
    return Number.isInteger(entry) && entry > 0 ? entry : null;
  }
  if (!entry || typeof entry !== 'object') {
    const n = Number(entry);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  const raw = entry.id ?? entry.storyId ?? entry.number;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Build the initial per-Story status map from a list of Story records (or
 * ids). Every Story seeds at `status: 'pending'`; an optional `title` is
 * carried through when the record supplies one so the operator rollup and
 * branch-cleanup surfaces have a label without a second fetch. Keys are the
 * positive-integer Story ids as strings (JSON object keys are strings);
 * shapeless / non-positive entries are dropped.
 *
 * Pure helper — exported for unit tests.
 *
 * @param {Array<object|number>} stories
 * @returns {Record<string, { status: string, title?: string }>}
 */
export function buildStoryStatusMap(stories) {
  const out = {};
  for (const entry of Array.isArray(stories) ? stories : []) {
    const id = storyIdOf(entry);
    if (id === null) continue;
    const record = { status: 'pending' };
    const title =
      entry && typeof entry === 'object' && typeof entry.title === 'string'
        ? entry.title
        : undefined;
    if (title) record.title = title;
    out[String(id)] = record;
  }
  return out;
}

/**
 * Read and parse the checkpoint. Returns null if the comment is missing or
 * unparseable (callers treat null as "start fresh").
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number }} opts
 * @returns {Promise<object | null>}
 */
export async function read({ provider, epicId } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const comment = await findStructuredComment(
    provider,
    epicId,
    EPIC_RUN_STATE_TYPE,
  );
  return parseFencedJsonComment(comment);
}

/**
 * Overwrite the checkpoint with `state`. Idempotent — callers may invoke
 * freely per tick; the marker-scoped upsert deletes the prior comment.
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, state: object }} opts
 */
export async function write({ provider, epicId, state } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const payload = {
    version: CHECKPOINT_SCHEMA_VERSION,
    ...state,
    lastUpdatedAt: new Date().toISOString(),
  };
  const body = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  await upsertStructuredComment(provider, epicId, EPIC_RUN_STATE_TYPE, body);
  return payload;
}

/**
 * Initial checkpoint for a brand-new run. Idempotent against re-dispatch:
 * when an existing checkpoint is found and the persisted `concurrencyCap`
 * matches the incoming value, the existing state is returned verbatim (no
 * rewrite) so a re-prepare preserves `startedAt`, prior Story statuses, and
 * `manualInterventions`. When the cap differs (an operator re-tuned the
 * global in-flight cap) it is refreshed in place; the Story status map is
 * **merged** so any Story that already reached a terminal status keeps it
 * while newly-discovered Stories are seeded at `pending`. Prepare owns the
 * Story set (it overwrites it on every run) but never clobbers recorded
 * progress.
 *
 * @param {{
 *   provider: import('../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   storyIds: Array<object|number>,
 *   concurrencyCap: number,
 * }} opts
 *   `concurrencyCap` is the GLOBAL in-flight cap the ready-set selector
 *   honours (`selectReadySet({ globalCap })`).
 */
export async function initialize({
  provider,
  epicId,
  storyIds,
  concurrencyCap,
} = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const seededStories = buildStoryStatusMap(storyIds);
  const existing = await read({ provider, epicId });
  if (existing) {
    const mergedStories = mergeStoryStatuses(existing.stories, seededStories);
    if (
      existing.concurrencyCap === concurrencyCap &&
      storyMapsEqual(existing.stories, mergedStories)
    ) {
      return existing;
    }
    return write({
      provider,
      epicId,
      state: { ...existing, concurrencyCap, stories: mergedStories },
    });
  }
  return write({
    provider,
    epicId,
    state: {
      epicId,
      startedAt: new Date().toISOString(),
      concurrencyCap,
      phase: 'prepare',
      stories: seededStories,
      manualInterventions: [],
    },
  });
}

/**
 * Merge a freshly-seeded Story status map onto a persisted one. Every Story
 * present in either map appears in the result; when a Story exists in the
 * prior map its recorded status / blockerCommentId win (recorded progress is
 * never lost), while its `title` is refreshed from the incoming seed when the
 * seed supplies one. Stories present only in the incoming seed are added at
 * their seeded (`pending`) status. Pure — exported for unit tests.
 *
 * @param {Record<string, object>|undefined} prior
 * @param {Record<string, object>} incoming
 * @returns {Record<string, object>}
 */
export function mergeStoryStatuses(prior, incoming) {
  const priorMap = prior && typeof prior === 'object' ? prior : {};
  const seedMap = incoming && typeof incoming === 'object' ? incoming : {};
  const out = {};
  for (const key of new Set([
    ...Object.keys(priorMap),
    ...Object.keys(seedMap),
  ])) {
    const priorEntry = priorMap[key];
    const seedEntry = seedMap[key];
    if (priorEntry && typeof priorEntry === 'object') {
      const merged = { ...priorEntry };
      if (seedEntry && typeof seedEntry.title === 'string') {
        merged.title = seedEntry.title;
      }
      out[key] = merged;
    } else {
      out[key] = seedEntry;
    }
  }
  return out;
}

/**
 * Structural equality on two Story status maps — same key set and, per key,
 * the same `status`, `title`, and `blockerCommentId`. Used by `initialize`
 * to decide whether an idempotent re-prepare needs a rewrite. Pure.
 *
 * @param {Record<string, object>|undefined} a
 * @param {Record<string, object>|undefined} b
 * @returns {boolean}
 */
function storyMapsEqual(a, b) {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const l = left[key] ?? {};
    const r = right[key];
    if (!r) return false;
    if (
      l.status !== r.status ||
      l.title !== r.title ||
      l.blockerCommentId !== r.blockerCommentId
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Record a per-Story terminal (or in-progress) status on the checkpoint.
 * Reads the current state first, splices the single Story's record into the
 * `stories` map, and re-writes. Other Stories and all run-level fields are
 * preserved verbatim. Tolerant of a legacy/absent `stories` map (treated as
 * empty) so a checkpoint that predates a field is upgraded in place.
 *
 * @param {{
 *   provider: import('../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   storyId: number,
 *   status: string,
 *   title?: string,
 *   blockerCommentId?: string|number|null,
 * }} opts
 * @returns {Promise<object>} the persisted state
 */
export async function recordStoryStatus({
  provider,
  epicId,
  storyId,
  status,
  title,
  blockerCommentId,
} = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const id = storyIdOf(storyId);
  if (id === null) {
    throw new TypeError(
      'recordStoryStatus: storyId must be a positive integer',
    );
  }
  if (!STORY_STATUSES.includes(status)) {
    throw new RangeError(
      `recordStoryStatus: status "${status}" must be one of: ${STORY_STATUSES.join(', ')}`,
    );
  }
  const existing = (await read({ provider, epicId })) ?? {};
  const stories =
    existing.stories && typeof existing.stories === 'object'
      ? { ...existing.stories }
      : {};
  const prior = stories[String(id)] ?? {};
  const record = { ...prior, status };
  if (typeof title === 'string' && title) record.title = title;
  if (status === 'blocked' && blockerCommentId != null) {
    record.blockerCommentId = String(blockerCommentId);
  }
  stories[String(id)] = record;
  return write({
    provider,
    epicId,
    state: { ...existing, stories },
  });
}

/**
 * Append a manual-intervention record to the checkpoint. Out-of-band
 * recovery steps the host LLM performs during a delivery — `AskUserQuestion`
 * calls, `git restore`/`git reset` against the working tree, manual `--no-ff`
 * recovery merges, story-close `--skipValidation` overrides — disqualify the
 * Epic from auto-merge. The auto-merge predicate reads this array and only
 * fires when it is empty.
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, entry: { reason: string, source?: string, ts?: string } }} opts
 * @returns {Promise<object>} the persisted state
 */
export async function appendIntervention({ provider, epicId, entry } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  if (!entry || typeof entry.reason !== 'string' || entry.reason.length === 0) {
    throw new TypeError('appendIntervention: { reason: string } is required.');
  }
  const existing = (await read({ provider, epicId })) ?? {};
  const list = Array.isArray(existing.manualInterventions)
    ? existing.manualInterventions
    : [];
  const record = {
    reason: entry.reason,
    source: typeof entry.source === 'string' ? entry.source : 'host-llm',
    ts: typeof entry.ts === 'string' ? entry.ts : new Date().toISOString(),
  };
  return write({
    provider,
    epicId,
    state: {
      ...existing,
      manualInterventions: [...list, record],
    },
  });
}

/**
 * Advance the checkpoint's `phase` field to the next `/deliver`
 * phase. Reads the current state first so the caller does not need to
 * keep an in-memory copy. Other state fields are preserved verbatim.
 *
 * Story #1155 / Epic #1142 — phase-granular resume. The runner writes
 * the **next phase to run** here, not the phase that just finished, so
 * a resume can match `phase === 'code-review'` to mean "Phase D is the
 * next thing to do."
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, nextPhase: string }} opts
 *   nextPhase - One of `DELIVER_PHASES` or `'done'`.
 */
export async function setPhase({ provider, epicId, nextPhase } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  assertValidDeliverPhase(nextPhase);
  const existing = (await read({ provider, epicId })) ?? {};
  return write({
    provider,
    epicId,
    state: { ...existing, phase: nextPhase },
  });
}
