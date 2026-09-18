/**
 * Re-export facade over `ticketing/` (reads, state mutators, bulk cascade)
 * so callers import everything from one path.
 */

export {
  __resetParentCascadeLocks,
  __setCascadeRetryDelays,
  logCascadePartialFailures,
} from './ticketing/bulk.js';
export {
  _peekStructuredCommentCache,
  _resetStructuredCommentCache,
  assertValidStructuredCommentType,
  buildStorylessTicketSnapshot,
  findStructuredComment,
  isValidStructuredCommentType,
  STATE_LABELS,
  STRUCTURED_COMMENT_TYPES,
  structuredCommentMarker,
  WAVE_TYPE_PATTERN,
} from './ticketing/reads.js';
export {
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionStoryDirect,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing/state.js';
