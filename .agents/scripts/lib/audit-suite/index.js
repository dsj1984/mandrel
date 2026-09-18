/** Audit-suite barrel — the only supported entry point. */

export {
  buildChecklistPayload,
  DEFAULT_CHECKLIST_TOKEN_BUDGET,
  matchLocalLenses,
  readAuditRules,
} from './checklist-threading.js';
export { buildDispatchChecklist } from './dispatch-checklist.js';
export {
  countChangedLines,
  evaluateLensDiffFloor,
} from './lens-diff-floor.js';
export { runAuditSuite } from './runner.js';
export {
  LENS_TIERS,
  matchesAnyFilePattern,
  matchesFilePattern,
  resolveLensTier,
  selectAudits,
  selectLocalLenses,
} from './selector.js';
