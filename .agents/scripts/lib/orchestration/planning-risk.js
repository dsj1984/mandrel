/**
 * planning-risk.js — deterministic Epic planning risk classifier.
 *
 * Stub placeholder for RED test coverage (Task #2790).
 */

/** Closed axis vocabulary for planning risk classification. */
export const PLANNING_RISK_AXES = Object.freeze([
  'visible-behavior',
  'public-api',
  'security',
  'data-migration',
  'billing',
  'destructive-mutation',
  'critical-workflow',
  'internal-refactor',
  'docs-only',
  'test-harness',
]);

/**
 * @param {{ title?: string, body?: string, labels?: string[] }} [_input]
 */
export function classifyPlanningRisk(_input = {}) {
  return {
    axes: [],
    overallLevel: 'low',
    requiresReview: false,
    acceptanceDisposition: 'not-applicable',
    gateDecision: 'auto-proceed',
  };
}
