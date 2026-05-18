/**
 * Test-only fixture adapter exposing the legacy Checkpointer-shaped
 * API backed by an in-memory record.
 *
 * Story #2423 (Epic #2307) — the production `Checkpointer` class
 * (`.agents/scripts/lib/orchestration/epic-runner/checkpointer.js`) was
 * deleted after every production caller was migrated to the stateless
 * `epic-run-state-store` module. The resume-suite tests under
 * `tests/epic-runner/`, `tests/epic-execute/`, `tests/workflows/`, and
 * `tests/lib/orchestration/lifecycle/` still validate the legacy
 * class-based read/write/initialize/setPhase/appendIntervention surface
 * because that is the behavioural contract the new stateless functions
 * inherit (byte-identical comment body, marker-scoped upsert
 * idempotence, manual-intervention append semantics).
 *
 * The bodies below are lifted verbatim from the deleted production
 * class so the structured-comment shape stays byte-for-byte equivalent.
 * No production module imports from this file — it is consumed by
 * tests only.
 */

import { assertValidDeliverPhase } from '../../.agents/scripts/lib/orchestration/epic-runner/deliver-phases.js';
import { parseFencedJsonComment } from '../../.agents/scripts/lib/orchestration/structured-comment-parser.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from '../../.agents/scripts/lib/orchestration/ticketing.js';

export const EPIC_RUN_STATE_TYPE = 'epic-run-state';
export const CHECKPOINT_SCHEMA_VERSION = 1;

// Re-export the phase enum + index helper so importers using this
// fixture as a single import target keep working unchanged.
export {
  DELIVER_PHASES,
  phaseIndex,
} from '../../.agents/scripts/lib/orchestration/epic-runner/deliver-phases.js';

export class Checkpointer {
  /**
   * @param {{ provider: object, epicId: number }} opts
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
   * `phase`).
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
   * Append a manual-intervention record to the checkpoint.
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
   * phase. Reads the current state first; other state fields are preserved.
   *
   * @param {string} nextPhase - One of `DELIVER_PHASES` or `'done'`.
   */
  async setPhase(nextPhase) {
    assertValidDeliverPhase(nextPhase);
    const existing = (await this.read()) ?? {};
    return this.write({ ...existing, phase: nextPhase });
  }
}
