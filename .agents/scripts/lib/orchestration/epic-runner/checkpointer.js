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

export const EPIC_RUN_STATE_TYPE = 'epic-run-state';
export const CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Ordered list of `/epic-deliver` phases (Story #1155 / Epic #1142). The
 * checkpoint's `phase` field stores the **next phase to run**, so a
 * mid-flight crash during `code-review` resumes by reading
 * `phase === 'code-review'` and re-entering Phase D from the start.
 *
 * Phase tags are stable identifiers — downstream tooling (the contract
 * test in `tests/workflows/epic-deliver.test.js`) asserts the phase
 * advancement contract directly against this list.
 */
export const DELIVER_PHASES = Object.freeze([
  'prepare',
  'wave-loop',
  'close-validation',
  'code-review',
  'retro',
  'finalize',
]);

/**
 * Pure: index of `phase` in `DELIVER_PHASES`. Returns `-1` for unknown
 * values (callers treat that as "start fresh"); `+Infinity` for the
 * terminal `'done'` sentinel.
 */
export function phaseIndex(phase) {
  if (phase === 'done') return Number.POSITIVE_INFINITY;
  const idx = DELIVER_PHASES.indexOf(phase);
  return idx;
}

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
   * Initial checkpoint for a brand-new run. Idempotent against re-dispatch —
   * if a checkpoint already exists it is returned unchanged.
   *
   * @param {{ totalWaves: number, concurrencyCap: number, autoClose: boolean }} opts
   */
  async initialize({ totalWaves, concurrencyCap, autoClose }) {
    const existing = await this.read();
    if (existing) return existing;
    return this.write({
      epicId: this.epicId,
      startedAt: new Date().toISOString(),
      autoClose: Boolean(autoClose),
      currentWave: 0,
      totalWaves,
      concurrencyCap,
      phase: 'prepare',
      waves: [],
      blockerHistory: [],
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
    if (nextPhase !== 'done' && phaseIndex(nextPhase) < 0) {
      throw new Error(
        `Checkpointer.setPhase: invalid phase ${JSON.stringify(nextPhase)}. ` +
          `Expected one of ${DELIVER_PHASES.join(', ')} or 'done'.`,
      );
    }
    const existing = (await this.read()) ?? {};
    return this.write({ ...existing, phase: nextPhase });
  }
}
