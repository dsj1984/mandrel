/**
 * lib/orchestration/index.js — Orchestration SDK Barrel Export
 *
 * Single entry point for the orchestration SDK. All public functions are
 * re-exported here so CLI wrappers and tests depend on this module rather
 * than reaching into internal module paths.
 *
 * @example
 *   import { dispatch, hydrateContext } from './lib/orchestration/index.js';
 */

// Audit execution and selection — re-export the SDK barrel under
// `lib/audit-suite/` rather than the top-level CLI files. This keeps the
// orchestration barrel's imports flowing inward (lib → lib) so the
// dependency graph never crosses out of `lib/` and back. Story #1083
// (Epic #1072) inverted the prior `../../{run-audit-suite,select-audits}.js`
// imports.
export { runAuditSuite, selectAudits } from '../audit-suite/index.js';
// Context hydration — builds the execution prompt for an agent task
export {
  hydrateContext,
  parseHierarchy,
  truncateToTokenBudget,
} from './context-hydration-engine.js';
// Core dispatcher — business logic for orchestrating Epic task waves
export { dispatch, resolveAndDispatch } from './dispatch-engine.js';
export { executeStory } from './story-executor.js';
// Ticketing operations — state transitions and hierarchy management
export {
  assertValidStructuredCommentType,
  cascadeCompletion,
  isValidStructuredCommentType,
  postStructuredComment,
  STATE_LABELS,
  STRUCTURED_COMMENT_TYPES,
  toggleTasklistCheckbox,
  transitionTicketState,
  upsertStructuredComment,
  WAVE_TYPE_PATTERN,
} from './ticketing.js';
// Wave-marker helper — canonical home for the bounded wave regex + parser.
export { parseWaveMarker, WAVE_MARKER_RE } from './wave-marker.js';
