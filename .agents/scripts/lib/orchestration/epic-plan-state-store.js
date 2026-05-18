/**
 * epic-plan-state-store — stateless functions for reading and writing the
 * `epic-plan-state` structured comment on the Epic issue.
 *
 * This module is the function-based replacement for `PlanCheckpointer`
 * (`./plan-runner/plan-checkpointer.js`). Bodies are lifted verbatim from
 * the corresponding `PlanCheckpointer` methods so the structured-comment
 * shape is preserved byte-for-byte. The `PlanCheckpointer` class remains
 * importable in this Story; it is removed by `story-delete-state-classes`.
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
 */

import {
  findStructuredComment,
  upsertStructuredComment,
} from './ticketing.js';

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

function assertProvider(provider) {
  if (!provider) throw new TypeError('epic-plan-state-store requires a provider');
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
  await upsertStructuredComment(
    provider,
    epicId,
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
  return write({ provider, epicId, state: { ...skeleton, ...seed } });
}

/**
 * Update only the `phase` field. Creates the checkpoint first if absent.
 *
 * @param {{ provider: import('../ITicketingProvider.js').ITicketingProvider, epicId: number, nextPhase: string }} opts
 */
export async function setPhase({ provider, epicId, nextPhase } = {}) {
  assertProvider(provider);
  assertEpicId(epicId);
  if (!Object.values(PLAN_PHASES).includes(nextPhase)) {
    throw new RangeError(
      `epic-plan-state-store.setPhase: unknown phase "${nextPhase}". Expected one of: ${Object.values(
        PLAN_PHASES,
      ).join(', ')}`,
    );
  }
  const current =
    (await read({ provider, epicId })) ??
    (await initialize({ provider, epicId }));
  return write({ provider, epicId, state: { ...current, phase: nextPhase } });
}
