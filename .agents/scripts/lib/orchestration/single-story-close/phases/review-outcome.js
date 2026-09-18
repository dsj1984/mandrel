/**
 * phases/review-outcome.js — renders the review outcome, always stating the
 * degraded gates (`none` when healthy) so "never ran" cannot read as
 * "found nothing". Degraded is reported, not blocking — and never claim
 * another gate covered the surface; this module cannot see that.
 */

import { summarizeDegradations } from '../../review-providers/degraded-gates.js';

/**
 * @param {{ severity: { critical: number, high: number, medium: number, suggestion: number }, degradations?: unknown }} args
 * @returns {string}
 */
export function buildOutcomeTally({ severity, degradations }) {
  return (
    `critical:${severity.critical} · high:${severity.high} · ` +
    `medium:${severity.medium} · suggestion:${severity.suggestion} · ` +
    `degraded gates: ${summarizeDegradations(degradations)}`
  );
}

/**
 * @param {{
 *   severity: { critical: number, high: number, medium: number, suggestion: number },
 *   degradations?: unknown,
 *   prNumber: number,
 *   posted: boolean,
 * }} args
 * @returns {string[]}
 */
export function formatReviewOutcomeLines({
  severity,
  degradations,
  prNumber,
  posted,
}) {
  const tally = buildOutcomeTally({ severity, degradations });
  const lines = [`Findings — ${tally}. Posted to PR #${prNumber}: ${posted}.`];
  if (summarizeDegradations(degradations) !== 'none') {
    lines.push(
      '⚠️ Review ran DEGRADED — the surface(s) above were not reviewed. The close ' +
        'is not blocked — a secondary review does not gate the merge — but ' +
        'nothing here vouches for those surfaces.',
    );
  }
  return lines;
}
