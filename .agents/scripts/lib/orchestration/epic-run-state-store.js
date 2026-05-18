/**
 * epic-run-state-store — stateless functions for reading and writing the
 * `epic-run-state` structured comment used by `/epic-deliver`.
 *
 * This module is the function-based replacement for `Checkpointer`
 * (`./epic-runner/checkpointer.js`). Bodies are lifted verbatim from the
 * corresponding `Checkpointer` methods so the structured-comment shape is
 * preserved byte-for-byte. The `Checkpointer` class remains importable in
 * this Story; it is removed by `story-delete-state-classes`.
 *
 * The comment is identified by a stable HTML marker so it can be overwritten
 * idempotently across orchestrator restarts. The body is a fenced JSON block
 * following the schema in tech spec #323.
 */

import { parseFencedJsonComment } from './structured-comment-parser.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from './ticketing.js';
import { assertValidDeliverPhase } from './epic-runner/deliver-phases.js';

export const EPIC_RUN_STATE_TYPE = 'epic-run-state';
export const CHECKPOINT_SCHEMA_VERSION = 1;

// Re-export the phase enum + index helper so downstream importers continue
// to use this module as a single import target.
export {
  DELIVER_PHASES,
  phaseIndex,
} from './epic-runner/deliver-phases.js';

function assertProvider(provider) {
  if (!provider) throw new TypeError('epic-run-state-store requires a provider');
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
  await upsertStructuredComment(
    provider,
    epicId,
    EPIC_RUN_STATE_TYPE,
    body,
  );
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
  if (
    !entry ||
    typeof entry.reason !== 'string' ||
    entry.reason.length === 0
  ) {
    throw new TypeError(
      'appendIntervention: { reason: string } is required.',
    );
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
