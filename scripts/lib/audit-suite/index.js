/**
 * lib/audit-suite/index.js — Audit-suite SDK barrel.
 *
 * Single library entry point for the audit-suite. Exports the two public
 * functions (`runAuditSuite`, `selectAudits`) plus the pure rule-matching
 * helpers (`matchesFilePattern`, `matchesAnyFilePattern`) used by both the
 * top-level CLIs (`run-audit-suite.js`, `select-audits.js`) and the
 * orchestration barrel (`lib/orchestration/index.js`).
 *
 * The orchestration barrel imports from this file rather than reaching
 * upward into the CLI scripts (`../../run-audit-suite.js`,
 * `../../select-audits.js`) — that direction inversion is the goal of
 * Story #1083 / Epic #1072.
 *
 * @example
 *   import { runAuditSuite, selectAudits } from './lib/audit-suite/index.js';
 */

export { runAuditSuite } from './runner.js';
export {
  matchesAnyFilePattern,
  matchesFilePattern,
  selectAudits,
} from './selector.js';
