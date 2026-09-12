/**
 * Soft-finding reporting for plan-persist.
 *
 * Story #5312 retired the fan-out gate that shared this file: the delete
 * blast-radius probe never refused a real plan, and its `--allow-large-fan-out`
 * override was a flag nobody typed. What remains is the one surface that
 * announces every advisory finding the validator produced, each under its
 * own kind, so the operator reads a conflict as a conflict and a nudge as a
 * nudge (Story #4907).
 *
 * @module lib/orchestration/plan-persist/soft-findings
 */

import { Logger } from '../../Logger.js';
import {
  CONFLICT_KINDS,
  renderHardConflictError,
} from '../ticket-validator-conflicts.js';

/**
 * Report every soft finding the validator produced, each under its own kind.
 *
 * Only the {@link CONFLICT_KINDS} are cross-Story conflicts. Any other soft
 * kind is a single-Story nudge, and announcing it as a conflict overstated it
 * and taught readers to discount the whole channel.
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
