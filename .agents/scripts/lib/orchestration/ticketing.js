/**
 * Re-export facade over `ticketing/` (reads, state mutators, bulk cascade)
 * so callers import everything from one path.
 */

export {
  __resetParentCascadeLocks,
  __setCascadeRetryDelays,
} from './ticketing/bulk.js';
export {
  _resetStructuredCommentCache,
  assertValidStructuredCommentType,
  findStructuredComment,
  STATE_LABELS,
} from './ticketing/reads.js';
export {
  postStructuredComment,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing/state.js';
