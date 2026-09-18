/**
 * Soft-finding reporting for plan-persist.
 *
 * @module lib/orchestration/plan-persist/soft-findings
 */

import { Logger } from '../../Logger.js';
import {
  CONFLICT_KINDS,
  renderHardConflictError,
} from '../ticket-validator-conflicts.js';

/**
 * Only {@link CONFLICT_KINDS} are reported as conflicts; other soft kinds are
 * single-Story advisories, so the channel is not overstated.
 *
 * @param {object[]} findings
 * @param {string} [tag]
 */
export function surfaceSoftConflictFindings(findings, tag = 'plan-persist') {
  const soft = (findings ?? []).filter((f) => f?.severity === 'soft');
  if (soft.length === 0) return;
  const conflicts = soft.filter((f) => CONFLICT_KINDS.has(f?.kind));
  const advisories = soft.filter((f) => !CONFLICT_KINDS.has(f?.kind));
  if (conflicts.length > 0) {
    Logger.warn(
      `[${tag}] ${conflicts.length} soft cross-Story conflict finding(s) — review before approving the plan:`,
    );
    for (const finding of conflicts) {
      Logger.warn(
        `[${tag}] soft conflict: ${renderHardConflictError(finding)}`,
      );
    }
  }
  if (advisories.length > 0) {
    Logger.warn(
      `[${tag}] ${advisories.length} advisory finding(s) — the persist proceeds:`,
    );
    for (const finding of advisories) {
      Logger.warn(
        `[${tag}] advisory (${finding.kind}): ${renderHardConflictError(finding)}`,
      );
    }
  }
}
