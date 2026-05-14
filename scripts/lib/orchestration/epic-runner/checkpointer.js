/**
 * Checkpointer — reads and writes the `epic-run-state` structured comment.
 *
 * The comment is identified by a stable HTML marker so it can be overwritten
 * idempotently across orchestrator restarts. The body is a fenced JSON block
 * following the schema in tech spec #323.
 */

import { parseFencedJsonComment } from '../structured-comment-parser.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from '../ticketing.js';
import { assertValidDeliverPhase } from './deliver-phases.js';

export const EPIC_RUN_STATE_TYPE = 'epic-run-state';
export const CHECKPOINT_SCHEMA_VERSION = 1;

// Re-export the phase enum + index helper so downstream importers
// continue to use `checkpointer.js` as a single import target.
export {
  DELIVER_PHASES,
  phaseIndex,
} from './deliver-phases.js';

export class Checkpointer {
  /**
   * @param {{ provider: import('../../ITicketingProvider.js').ITicketingProvider, epicId: number }} opts
   */
  constructor(opts = {}) {
    const ctx = opts.ctx;
    const provider = opts.provider ?? ctx?.provider;
    const epicId = opts.epicId ?? ctx?.epicId;
    if (!provider) throw new TypeError('Checkpointer requires a provider');
    if (!Number.isInteger(epicId)) {
      throw new TypeError('Checkpointer requires a numeric epicId');
    }
    this.provider = provider;
    this.epicId = epicId;
  }

  /**
   * Read and parse the checkpoint. Returns null if the comment is missing or
   * unparseable (callers treat null as "start fresh").
   *
   * @returns {Promise<object | null>}
   */
  async read() {
    const comment = await findStructuredComment(
      this.provider,
      this.epicId,
      EPIC_RUN_STATE_TYPE,
    );
    return parseFencedJsonComment(comment);
  }

  /**
   * Overwrite the checkpoint with `state`. Idempotent — callers may invoke
   * freely per wave; the marker-scoped upsert deletes the prior comment.
   *
   * @param {object} state
   */
  async write(state) {
    const payload = {
      version: CHECKPOINT_SCHEMA_VERSION,
      ...state,
      lastUpdatedAt: new Date().toISOString(),
    };
    const body = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    await upsertStructuredComment(
      this.provider,
      this.epicId,
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
   * @param {{ totalWaves: number, concurrencyCap: number }} opts
   */
  async initialize({ totalWaves, concurrencyCap }) {
    const existing = await this.read();
    if (existing) {
      if (
        existing.totalWaves === totalWaves &&
        existing.concurrencyCap === concurrencyCap
      ) {
        return existing;
      }
      return this.write({ ...existing, totalWaves, concurrencyCap });
    }
    return this.write({
      epicId: this.epicId,
      startedAt: new Date().toISOString(),
      currentWave: 0,
      totalWaves,
      concurrencyCap,
      phase: 'prepare',
      waves: [],
      blockerHistory: [],
      manualInterventions: [],
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
   * @param {{ reason: string, source?: string, ts?: string }} entry
   * @returns {Promise<object>} the persisted state
   */
  async appendIntervention(entry) {
    if (
      !entry ||
      typeof entry.reason !== 'string' ||
      entry.reason.length === 0
    ) {
      throw new TypeError(
        'appendIntervention: { reason: string } is required.',
      );
    }
    const existing = (await this.read()) ?? {};
    const list = Array.isArray(existing.manualInterventions)
      ? existing.manualInterventions
      : [];
    const record = {
      reason: entry.reason,
      source: typeof entry.source === 'string' ? entry.source : 'host-llm',
      ts: typeof entry.ts === 'string' ? entry.ts : new Date().toISOString(),
    };
    return this.write({
      ...existing,
      manualInterventions: [...list, record],
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
   * @param {string} nextPhase - One of `DELIVER_PHASES` or `'done'`.
   */
  async setPhase(nextPhase) {
    assertValidDeliverPhase(nextPhase);
    const existing = (await this.read()) ?? {};
    return this.write({ ...existing, phase: nextPhase });
  }
}
