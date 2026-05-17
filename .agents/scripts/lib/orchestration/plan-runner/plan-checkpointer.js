/**
 * PlanCheckpointer — reads and writes the `epic-plan-state` structured
 * comment on the Epic issue.
 *
 * Schema (see Tech Spec #351):
 *
 * ```json
 * {
 *   "version": 1,
 *   "epicId": 349,
 *   "phase": "review-spec",
 *   "startedAt": "...",
 *   "lastUpdatedAt": "...",
 *   "spec": { "prdId": null, "techSpecId": null, "acceptanceSpecId": null, "completedAt": null },
 *   "decompose": { "ticketCount": null, "completedAt": null },
 *   "manifestCommentId": null
 * }
 * ```
 *
 * The comment is identified by the marker emitted by `structuredCommentMarker`
 * for type `epic-plan-state`, matching the `epic-run-state` pattern used by
 * the epic runner's `Checkpointer`.
 */

import {
  findStructuredComment,
  upsertStructuredComment,
} from '../ticketing.js';

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
   * @param {{ provider: import('../../ITicketingProvider.js').ITicketingProvider, epicId: number }} opts
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
   *
   * @returns {Promise<object | null>}
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
   *
   * @param {object} state
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
   * is present, otherwise writes a fresh skeleton. Overrides from `seed` are
   * merged into a freshly-written skeleton; an already-present checkpoint is
   * returned unchanged.
   *
   * @param {object} [seed] Partial state used only when writing fresh.
   * @returns {Promise<object>}
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
   *
   * @param {string} phase One of PLAN_PHASES values.
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
   *
   * @param {{ prdId?: number|null, techSpecId?: number|null, acceptanceSpecId?: number|null, completedAt?: string|null }} spec
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
   *
   * @param {{ ticketCount?: number|null, completedAt?: string|null }} decompose
   */
  async updateDecompose(decompose) {
    const current = (await this.read()) ?? (await this.initialize());
    return this.write({
      ...current,
      decompose: { ...current.decompose, ...decompose },
    });
  }

  /**
   * Record the dispatch manifest comment ID so downstream tooling (notifier,
   * external dashboards) can deep-link to it.
   *
   * @param {number} manifestCommentId
   */
  async setManifestCommentId(manifestCommentId) {
    const current = (await this.read()) ?? (await this.initialize());
    return this.write({ ...current, manifestCommentId });
  }
}
