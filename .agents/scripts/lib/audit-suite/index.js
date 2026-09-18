/**
 * lib/audit-suite/index.js — Audit-suite SDK barrel.
 *
 * Single library entry point for the audit-suite. Exports the two public
 * functions (`runAuditSuite`, `selectAudits`) plus the pure rule-matching
 * helpers (`matchesFilePattern`, `matchesAnyFilePattern`).
 *
 * Consumers import from this file — the former top-level CLI wrappers
 * (`run-audit-suite.js`, `select-audits.js`) were retired in #4482; this
 * barrel is the only supported entry point (Story #1083 / Epic #1072).
 *
 * @example
 *   import { runAuditSuite, selectAudits } from './lib/audit-suite/index.js';
 */

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
