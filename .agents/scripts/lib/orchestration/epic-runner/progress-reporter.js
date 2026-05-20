/**
 * progress-reporter.js — facade module for the /epic-deliver progress
 * narrative. Story #1847 split the original 1158-LOC monolith into three
 * sibling sub-modules under `progress-reporter/`:
 *
 *   - `composition.js` — structured-comment body builders and the pure
 *     rendering helpers (the legacy ProgressReporter class used these).
 *   - `transport.js` — the curated webhook emit surface (epic-started,
 *     epic-progress, epic-blocked, epic-unblocked, epic-complete).
 *   - `signals.js` — pure parse/aggregate over `story-run-progress` and
 *     `phase-timings` structured comments + the shared state lookup
 *     tables (PHASE_TO_STATE, PHASE_ORDER, STATE_EMOJI).
 *
 * Epic #2646 Story C (Task #2699) — the tick-based polling
 * `ProgressReporter` class that used to live here was deleted in favour
 * of the bus-driven `lifecycle/listeners/progress-reporter.js` which
 * already consumes `story.dispatch.end` + `wave.end` to compose the
 * `epic-run-progress` body. The webhook helpers and parse/aggregate
 * exports remain at this path so existing importers
 * (`epic-execute-record-wave.js`, `wave-record-notifications.js`,
 * `crap-remediation-1641.test.js`) keep resolving — only the periodic
 * emission shell went away.
 */

import {
  deriveState as deriveStateFromComposition,
  renderProgressBody as renderProgressBodyFromComposition,
  truncate as truncateFromComposition,
  upsertEpicRunProgress as upsertEpicRunProgressFromComposition,
} from './progress-reporter/composition.js';
import {
  aggregatePhaseTimings as aggregatePhaseTimingsFromSignals,
  EPIC_RUN_PROGRESS_TYPE as EPIC_RUN_PROGRESS_TYPE_FROM_SIGNALS,
  PHASE_TIMINGS_TYPE as PHASE_TIMINGS_TYPE_FROM_SIGNALS,
  parsePhaseTimingsComment as parsePhaseTimingsCommentFromSignals,
  parseStoryRunProgressComment as parseStoryRunProgressCommentFromSignals,
  phaseToState as phaseToStateFromSignals,
  renderPhaseTimingsSection as renderPhaseTimingsSectionFromSignals,
  STORY_RUN_PROGRESS_TYPE as STORY_RUN_PROGRESS_TYPE_FROM_SIGNALS,
} from './progress-reporter/signals.js';
import {
  EPIC_PROGRESS_EVENT as EPIC_PROGRESS_EVENT_FROM_TRANSPORT,
  emitEpicBlocked as emitEpicBlockedFromTransport,
  emitEpicComplete as emitEpicCompleteFromTransport,
  emitEpicProgress as emitEpicProgressFromTransport,
  emitEpicStarted as emitEpicStartedFromTransport,
  emitEpicUnblocked as emitEpicUnblockedFromTransport,
} from './progress-reporter/transport.js';

// Re-exports — sub-module surfaces are aliased back to the parent path so
// existing imports (epic-execute-record-wave.js,
// wave-record-notifications.js) keep resolving.
export const EPIC_RUN_PROGRESS_TYPE = EPIC_RUN_PROGRESS_TYPE_FROM_SIGNALS;
export const PHASE_TIMINGS_TYPE = PHASE_TIMINGS_TYPE_FROM_SIGNALS;
export const STORY_RUN_PROGRESS_TYPE = STORY_RUN_PROGRESS_TYPE_FROM_SIGNALS;
export const EPIC_PROGRESS_EVENT = EPIC_PROGRESS_EVENT_FROM_TRANSPORT;
export const emitEpicProgress = emitEpicProgressFromTransport;
export const emitEpicStarted = emitEpicStartedFromTransport;
export const emitEpicBlocked = emitEpicBlockedFromTransport;
export const emitEpicUnblocked = emitEpicUnblockedFromTransport;
export const emitEpicComplete = emitEpicCompleteFromTransport;
export const parseStoryRunProgressComment =
  parseStoryRunProgressCommentFromSignals;
export const parsePhaseTimingsComment = parsePhaseTimingsCommentFromSignals;
export const aggregatePhaseTimings = aggregatePhaseTimingsFromSignals;
export const renderPhaseTimingsSection = renderPhaseTimingsSectionFromSignals;
export const phaseToState = phaseToStateFromSignals;
export const upsertEpicRunProgress = upsertEpicRunProgressFromComposition;
export const deriveState = deriveStateFromComposition;
export const renderProgressBody = renderProgressBodyFromComposition;
export const truncate = truncateFromComposition;
