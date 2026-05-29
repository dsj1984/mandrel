/**
 * epic-run-state-store — stateless functions for reading and writing the
 * `epic-run-state` structured comment used by `/epic-deliver`.
 *
 * This module is the function-based replacement for the legacy
 * `Checkpointer` class that previously lived at
 * `./epic-runner/checkpointer.js`. Bodies were lifted verbatim from the
 * corresponding `Checkpointer` methods so the structured-comment shape is
 * preserved byte-for-byte. Story #2423 (Epic #2307) deleted the class
 * file; the class API survives as a tests-only fixture at
 * `tests/fixtures/epic-run-state-store.js`.
 *
 * The comment is identified by a stable HTML marker so it can be overwritten
 * idempotently across orchestrator restarts. The body is a fenced JSON block
 * following the schema in tech spec #323.
 */

import { assertValidDeliverPhase } from './epic-runner/deliver-phases.js';
import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, upsertStructuredComment } from './ticketing.js';

export const EPIC_RUN_STATE_TYPE = 'epic-run-state';
export const CHECKPOINT_SCHEMA_VERSION = 1;

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
 * freely per wave; the marker-scoped upsert deletes the prior comment.
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
 * Initial checkpoint for a brand-new run. Idempotent against re-dispatch
 * when the wave shape is unchanged. When an existing checkpoint is found
 * but the incoming `totalWaves` or `concurrencyCap` differs from the
 * persisted values, refresh those fields in place — preserving
 * `currentWave`, `waves[]`, `blockerHistory`, `manualInterventions`,
 * `startedAt`, and any other already-persisted fields (e.g., `plan`,
 * `phase`). The `plan` field is owned by the prepare caller, which
 * overwrites it on every prepare run, so it does not need a delta check
 * here.
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, totalWaves: number, concurrencyCap: number }} opts
 */
export async function initialize({
  provider,
  epicId,
  totalWaves,
  concurrencyCap,
} = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const existing = await read({ provider, epicId });
  if (existing) {
    if (
      existing.totalWaves === totalWaves &&
      existing.concurrencyCap === concurrencyCap
    ) {
      return existing;
    }
    return write({
      provider,
      epicId,
      state: { ...existing, totalWaves, concurrencyCap },
    });
  }
  return write({
    provider,
    epicId,
    state: {
      epicId,
      startedAt: new Date().toISOString(),
      currentWave: 0,
      totalWaves,
      concurrencyCap,
      phase: 'prepare',
      waves: [],
      blockerHistory: [],
      manualInterventions: [],
    },
  });
}

/**
 * Reconcile the resume pointer (`currentWave` + `waves[]` history) against
 * a freshly-recomputed wave plan.
 *
 * Story #3358 — when `/epic-deliver` is resumed on a partially-complete
 * Epic, `epic-deliver-prepare.js` recomputes the wave DAG over only the
 * **not-done** Stories (`build-wave-dag.js#discoverOpenStories` drops the
 * closed/merged Stories). The recomputed plan is therefore *shorter* and
 * **re-indexed from 0** — `plan[0]` is the next ready wave. The preserved
 * checkpoint, however, still carries the prior `currentWave` (e.g. `2`)
 * and a `waves[]` history keyed to the *old* index space. `wave-tick.js`
 * then indexes `plan[currentWave]` into the new plan and dispatches the
 * wrong wave — silently skipping the Stories that are actually ready.
 *
 * Prepare already owns the `plan` field (it overwrites it on every run),
 * so it must equally own the pointer that indexes into that plan. This
 * helper is the single point of reconciliation:
 *
 *   - When the recomputed `nextPlan` is **structurally identical** to the
 *     persisted `priorPlan` (an idempotent re-prepare with no Story
 *     completed since the last run), the pointer is preserved verbatim so
 *     in-flight wave progress is not lost.
 *   - When the recomputed `nextPlan` **differs** (a Story merged → the
 *     plan got shorter / re-indexed), the pointer is reset: `currentWave`
 *     to `0` (the new plan's index space starts at the first not-done
 *     wave) and `waves[]` to `[]` (the prior history references the old
 *     index space and would mis-key `readGateFailures`).
 *
 * Plan equality is compared on the Story-id matrix only — `title` /
 * `worktree` churn on an otherwise-identical plan must not trip a reset.
 *
 * Pure function — no I/O, no provider, no side effects.
 *
 * @param {{
 *   currentWave?: number,
 *   waves?: Array<unknown>,
 * }} checkpoint The persisted checkpoint fields to reconcile.
 * @param {Array<Array<{ id?: number, storyId?: number, number?: number }>>} priorPlan
 *   The plan currently persisted on the checkpoint (may be undefined on a
 *   first run).
 * @param {Array<Array<{ id?: number, storyId?: number, number?: number }>>} nextPlan
 *   The freshly-recomputed plan prepare is about to persist.
 * @returns {{ currentWave: number, waves: Array<unknown> }} The reconciled
 *   pointer fields. Always returns concrete values so the caller can spread
 *   them onto the checkpoint payload unconditionally.
 */
export function reconcileResumePointer(checkpoint, priorPlan, nextPlan) {
  const safeWaves = Array.isArray(checkpoint?.waves) ? checkpoint.waves : [];
  const currentWave = Number.isInteger(checkpoint?.currentWave)
    ? checkpoint.currentWave
    : 0;
  if (planStoryMatrixEqual(priorPlan, nextPlan)) {
    return { currentWave, waves: safeWaves };
  }
  // Plan was recomputed (resume after a completed wave): the new plan is
  // 0-indexed over the remaining not-done waves. Reset the pointer and
  // drop the stale history so `wave-tick.js` reads `plan[0]`.
  return { currentWave: 0, waves: [] };
}

/**
 * Compare two wave plans on their Story-id matrix only. Each plan is
 * `Array<Array<{ id|storyId|number }>>`; equality requires the same wave
 * count, the same per-wave Story count, and the same Story ids in the same
 * positions. `title` / `worktree` fields are ignored so cosmetic churn on
 * an otherwise-identical plan does not register as a change.
 *
 * Pure helper for {@link reconcileResumePointer}.
 *
 * @param {Array<Array<object>>|undefined} a
 * @param {Array<Array<object>>|undefined} b
 * @returns {boolean}
 */
function planStoryMatrixEqual(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const wl = Array.isArray(left[i]) ? left[i] : [];
    const wr = Array.isArray(right[i]) ? right[i] : [];
    if (wl.length !== wr.length) return false;
    for (let j = 0; j < wl.length; j += 1) {
      if (storyIdOf(wl[j]) !== storyIdOf(wr[j])) return false;
    }
  }
  return true;
}

/**
 * Extract the Story id from a plan entry. Mirrors the resolution order
 * `wave-runner/tick.js#storyIdOf` uses so the equality check keys on the
 * same identity the tick dispatches against. Returns `null` for shapeless
 * entries so two `null`s never compare equal by accident.
 *
 * @param {object|number|null|undefined} entry
 * @returns {number|null}
 */
function storyIdOf(entry) {
  if (typeof entry === 'number') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.id ?? entry.storyId ?? entry.number;
  return Number.isInteger(id) ? id : null;
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
 * Advance the checkpoint's `phase` field to the next `/epic-deliver`
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
