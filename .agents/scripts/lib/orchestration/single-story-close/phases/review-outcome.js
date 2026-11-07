/**
 * phases/review-outcome.js — renders the review outcome, always stating the
 * degraded gates (`none` when healthy) so "never ran" cannot read as
 * "found nothing". It never claims another gate covered the surface; this
 * module cannot see that.
 */

import {
  reviewGapLines,
  summarizeDegradations,
} from '../../review-providers/degraded-gates.js';

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
  return [
    `Findings — ${tally}. Posted to PR #${prNumber}: ${posted}.`,
    ...reviewGapLines(degradations),
  ];
}
