/**
 * Test-only fixture adapter exposing the legacy PlanCheckpointer-shaped
 * API backed by an in-memory record.
 *
 * Story #2423 (Epic #2307) — the production `PlanCheckpointer` class
 * (`.agents/scripts/lib/orchestration/plan-runner/plan-checkpointer.js`)
 * was deleted after every production caller was migrated to the stateless
 * `epic-plan-state-store` module. The two resume-suite tests that
 * exercise the class API (`tests/lib/plan-checkpointer.test.js` and
 * `tests/lib/orchestration/epic-plan-state-store.test.js`) import from
 * this fixture so the byte-identical comment-body parity coverage
 * survives the production-code deletion.
 *
 * The body below is lifted verbatim from the deleted production class so
 * the structured-comment shape stays byte-for-byte equivalent. No
 * production module imports from this file — it is consumed by tests
 * only.
 */

import {
  findStructuredComment,
  upsertStructuredComment,
} from '../../.agents/scripts/lib/orchestration/ticketing.js';

export const EPIC_PLAN_STATE_TYPE = 'epic-plan-state';
export const PLAN_CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Enumeration of lifecycle phase values written to the checkpoint:
 *
 *   planning       — spec work running
 *   review-spec    — spec done; awaiting review (Epic carries agent::review-spec)
 *   decomposing    — decompose work running
 *   ready          — plan complete (Epic carries agent::ready)
 */
export const PLAN_PHASES = Object.freeze({
  PLANNING: 'planning',
  REVIEW_SPEC: 'review-spec',
  DECOMPOSING: 'decomposing',
  READY: 'ready',
});

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/;

export class PlanCheckpointer {
  /**
   * @param {{ provider: object, epicId: number }} opts
   */
  constructor(opts = {}) {
    const ctx = opts.ctx;
    const provider = opts.provider ?? ctx?.provider;
    const epicId = opts.epicId ?? ctx?.epicId;
    if (!provider) throw new TypeError('PlanCheckpointer requires a provider');
    if (!Number.isInteger(epicId)) {
      throw new TypeError('PlanCheckpointer requires a numeric epicId');
    }
    this.provider = provider;
    this.epicId = epicId;
  }

  /**
   * Read and parse the checkpoint. Returns null if the comment is missing or
   * unparseable (callers treat null as "start fresh").
   */
  async read() {
    const comment = await findStructuredComment(
      this.provider,
      this.epicId,
      EPIC_PLAN_STATE_TYPE,
    );
    if (!comment?.body) return null;
    const match = comment.body.match(JSON_FENCE_RE);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (_err) {
      return null;
    }
  }

  /**
   * Overwrite the checkpoint with the supplied merged state.
   */
  async write(state) {
    const payload = {
      version: PLAN_CHECKPOINT_SCHEMA_VERSION,
      ...state,
      lastUpdatedAt: new Date().toISOString(),
    };
    const body = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    await upsertStructuredComment(
      this.provider,
      this.epicId,
      EPIC_PLAN_STATE_TYPE,
      body,
    );
    return payload;
  }

  /**
   * Initialize the checkpoint. Idempotent — returns the existing state if one
   * is present, otherwise writes a fresh skeleton.
   */
  async initialize(seed = {}) {
    const existing = await this.read();
    if (existing) return existing;
    const now = new Date().toISOString();
    const skeleton = {
      epicId: this.epicId,
      phase: PLAN_PHASES.PLANNING,
      startedAt: now,
      spec: {
        prdId: null,
        techSpecId: null,
        acceptanceSpecId: null,
        completedAt: null,
      },
      decompose: { ticketCount: null, completedAt: null },
      manifestCommentId: null,
    };
    return this.write({ ...skeleton, ...seed });
  }

  /**
   * Update only the `phase` field. Creates the checkpoint first if absent.
   */
  async setPhase(phase) {
    if (!Object.values(PLAN_PHASES).includes(phase)) {
      throw new RangeError(
        `PlanCheckpointer.setPhase: unknown phase "${phase}". Expected one of: ${Object.values(
          PLAN_PHASES,
        ).join(', ')}`,
      );
    }
    const current = (await this.read()) ?? (await this.initialize());
    return this.write({ ...current, phase });
  }

  /**
   * Merge a partial spec-phase result into the checkpoint.
   */
  async updateSpec(spec) {
    const current = (await this.read()) ?? (await this.initialize());
    return this.write({
      ...current,
      spec: { ...current.spec, ...spec },
    });
  }

  /**
   * Merge a partial decompose-phase result into the checkpoint.
   */
  async updateDecompose(decompose) {
    const current = (await this.read()) ?? (await this.initialize());
    return this.write({
      ...current,
      decompose: { ...current.decompose, ...decompose },
    });
  }

  /**
   * Record the dispatch manifest comment ID so downstream tooling can deep-link to it.
   */
  async setManifestCommentId(manifestCommentId) {
    const current = (await this.read()) ?? (await this.initialize());
    return this.write({ ...current, manifestCommentId });
  }
}
