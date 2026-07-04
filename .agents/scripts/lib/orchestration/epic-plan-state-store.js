/**
 * epic-plan-state-store — stateless functions for reading and writing the
 * `epic-plan-state` structured comment on the Epic issue.
 *
 * This module is the function-based replacement for the legacy
 * `PlanCheckpointer` class that previously lived at
 * `./plan-runner/plan-checkpointer.js`. Bodies were lifted verbatim from
 * the corresponding `PlanCheckpointer` methods so the structured-comment
 * shape is preserved byte-for-byte. Story #2423 (Epic #2307) deleted
 * the class file; the class API survives as a tests-only fixture at
 * `tests/fixtures/epic-plan-state-store.js`.
 *
 * Schema (see Tech Spec #351):
 *
 * ```json
 * {
 *   "version": 1,
 *   "epicId": 349,
 *   "startedAt": "...",
 *   "lastUpdatedAt": "...",
 *   "spec": { "techSpecPersisted": false, "acceptanceTable": "none", "completedAt": null },
 *   "decompose": { "ticketCount": null, "completedAt": null },
 *   "planningRisk": { "overallLevel": "...", "requiresReview": true, "gateDecision": "..." },
 *   "reviewRouting": { "decision": "review-required|auto-proceed|operator-override-review", "requiresStop": true, "forceReviewApplied": false },
 *   "manifestCommentId": null
 * }
 * ```
 *
 * The checkpoint no longer carries a write-only `phase` field (Story #3909):
 * the lifecycle phase is already authoritative on the Epic's `agent::*` labels,
 * so the duplicate `phase` telemetry (and its `setPhase` round-trips) was
 * deleted. The fields that survive — `spec`, `decompose`, `planningRisk`,
 * `reviewRouting`, `manifestCommentId` — are the ones `/plan --resume`
 * reads to skip already-completed work.
 */

import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, upsertStructuredComment } from './ticketing.js';

export const EPIC_PLAN_STATE_TYPE = 'epic-plan-state';
export const PLAN_CHECKPOINT_SCHEMA_VERSION = 1;

function assertProvider(provider) {
  if (!provider)
    throw new TypeError('epic-plan-state-store requires a provider');
}

function assertEpicId(epicId) {
  if (!Number.isInteger(epicId)) {
    throw new TypeError('epic-plan-state-store requires a numeric epicId');
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
    EPIC_PLAN_STATE_TYPE,
  );
  return parseFencedJsonComment(comment);
}

/**
 * Overwrite the checkpoint with the supplied merged state.
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, state: object }} opts
 */
export async function write({ provider, epicId, state } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const payload = {
    version: PLAN_CHECKPOINT_SCHEMA_VERSION,
    ...state,
    lastUpdatedAt: new Date().toISOString(),
  };
  const body = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  await upsertStructuredComment(provider, epicId, EPIC_PLAN_STATE_TYPE, body);
  return payload;
}

/**
 * Initialize the checkpoint. Idempotent — returns the existing state if one
 * is present, otherwise writes a fresh skeleton. Overrides from `seed` are
 * merged into a freshly-written skeleton; an already-present checkpoint is
 * returned unchanged.
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, seed?: object }} opts
 * @returns {Promise<object>}
 */
export async function initialize({ provider, epicId, seed = {} } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  const existing = await read({ provider, epicId });
  if (existing) return existing;
  const now = new Date().toISOString();
  const skeleton = {
    epicId,
    startedAt: now,
    spec: {
      techSpecPersisted: false,
      acceptanceTable: 'none',
      completedAt: null,
    },
    decompose: { ticketCount: null, completedAt: null },
    manifestCommentId: null,
  };
  return write({ provider, epicId, state: { ...skeleton, ...seed } });
}
