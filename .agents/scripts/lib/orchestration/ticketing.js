/**
 * lib/orchestration/ticketing.js — Ticketing Operations SDK (facade).
 *
 * Stateless logic for updating ticket states, toggling checkboxes,
 * posting comments, and cascading completions. This module delegates
 * all API calls to the provided ITicketingProvider instance.
 *
 * Story #1848 — the implementation is split by verb family across the
 * sibling `ticketing/` sub-directory:
 *
 *   - `./ticketing/reads.js`  — read-only helpers, validators, and the
 *                               process-level structured-comment cache.
 *   - `./ticketing/state.js`  — per-ticket mutators including
 *                               `transitionTicketState` (below CRAP 12
 *                               via predicate extraction).
 *   - `./ticketing/bulk.js`   — cascade walk, per-parent serial lock,
 *                               transient-error retry budget, and the
 *                               partial-failure log helper.
 *
 * This file is a pure re-export facade: external callers continue to
 * import every name from `./ticketing.js`, so the split is invisible at
 * the import boundary.
 */

// Re-export the cascade + bulk surface.
export {
  __resetParentCascadeLocks,
  __setCascadeRetryDelays,
  cascadeCompletion,
  groupByAncestor,
  logCascadePartialFailures,
} from './ticketing/bulk.js';
// Re-export the read surface.
export {
  _peekStructuredCommentCache,
  _resetStructuredCommentCache,
  assertValidStructuredCommentType,
  findStructuredComment,
  isValidStructuredCommentType,
  STATE_LABELS,
  STRUCTURED_COMMENT_TYPES,
  structuredCommentMarker,
  WAVE_TYPE_PATTERN,
} from './ticketing/reads.js';
// Re-export the per-ticket state-mutation surface.
export {
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing/state.js';
