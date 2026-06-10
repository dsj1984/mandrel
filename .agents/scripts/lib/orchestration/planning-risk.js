/**
 * planning-risk.js — derive the Epic planning-risk envelope from a
 * planner-authored risk verdict.
 *
 * Pure ESM, no I/O. The planner (the `epic-plan-spec-author` Skill) judges
 * the Epic it just specced and supplies a verdict of shape
 * `{ axes: [{ axis, level, rationale }], summary }`, validated against
 * `.agents/schemas/risk-verdict.schema.json` before it reaches this module.
 * This module owns the deterministic control-flow outputs — overall level,
 * review requirement, acceptance disposition, and gate decision — so the
 * model supplies the *judgment input* while the harness owns the *gate
 * decision* (Epic #3865 hard cutover from the retired keyword-regex
 * classifier; see `docs/roadmap.md` Part 1).
 */

/** @typedef {'low' | 'medium' | 'high'} RiskLevel */
/** @typedef {'required' | 'recommended' | 'not-applicable'} AcceptanceDisposition */
/** @typedef {'review-required' | 'auto-proceed'} GateDecision */

/**
 * @typedef {Object} PlanningRiskAxis
 * @property {string} axis
 * @property {RiskLevel} level
 * @property {string} rationale
 */

/**
 * @typedef {Object} RiskVerdict
 * @property {PlanningRiskAxis[]} axes
 * @property {string} summary
 */

/**
 * @typedef {Object} PlanningRiskEnvelope
 * @property {PlanningRiskAxis[]} axes
 * @property {RiskLevel} overallLevel
 * @property {boolean} requiresReview
 * @property {AcceptanceDisposition} acceptanceDisposition
 * @property {GateDecision} gateDecision
 */

const LEVEL_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * Axes whose presence forces a `required` acceptance disposition. Mirrored
 * by the `axis` enum in `.agents/schemas/risk-verdict.schema.json` — keep
 * the two lists in sync.
 */
export const REQUIRED_AXES = new Set([
  'visible-behavior',
  'public-api',
  'security',
  'data-migration',
  'billing',
  'destructive-mutation',
  'critical-workflow',
]);

/**
 * Axes that, when they are the only signals present, waive the acceptance
 * spec (`not-applicable`). Mirrored by the `axis` enum in
 * `.agents/schemas/risk-verdict.schema.json` — keep the two lists in sync.
 */
export const NOT_APPLICABLE_AXES = new Set([
  'docs-only',
  'test-harness',
  'internal-refactor',
]);

/**
 * @param {PlanningRiskAxis[]} axes
 * @returns {RiskLevel}
 */
function resolveOverallLevel(axes) {
  if (axes.length === 0) return 'low';
  return axes.reduce(
    (highest, entry) =>
      LEVEL_RANK[entry.level] > LEVEL_RANK[highest] ? entry.level : highest,
    'low',
  );
}

/**
 * @param {PlanningRiskAxis[]} axes
 * @param {RiskLevel} overallLevel
 * @returns {AcceptanceDisposition}
 */
function resolveAcceptanceDisposition(axes, overallLevel) {
  const requiredAxes = axes.filter((entry) => REQUIRED_AXES.has(entry.axis));
  if (requiredAxes.length > 0) {
    return 'required';
  }
  if (
    overallLevel === 'medium' ||
    axes.some((entry) => entry.level === 'medium')
  ) {
    return 'recommended';
  }
  if (
    axes.length > 0 &&
    axes.every((entry) => NOT_APPLICABLE_AXES.has(entry.axis))
  ) {
    return 'not-applicable';
  }
  if (overallLevel === 'low') return 'not-applicable';
  return 'recommended';
}

/**
 * @param {RiskLevel} overallLevel
 * @param {PlanningRiskAxis[]} axes
 * @returns {boolean}
 */
function resolveRequiresReview(overallLevel, axes) {
  if (overallLevel === 'high') return true;
  if (overallLevel === 'medium') {
    return axes.some(
      (entry) =>
        entry.level === 'medium' &&
        (REQUIRED_AXES.has(entry.axis) || entry.axis === 'visible-behavior'),
    );
  }
  return false;
}

/**
 * Derive the stable planningRisk envelope from a schema-validated planner
 * verdict. Pure derivation — schema validation happens at the read boundary
 * (`epic-plan-spec.js`), never here, so a malformed verdict fails closed
 * before this function runs.
 *
 * @param {RiskVerdict} [verdict]
 * @returns {PlanningRiskEnvelope}
 */
export function deriveRiskEnvelope(verdict = {}) {
  const axes = (Array.isArray(verdict.axes) ? verdict.axes : []).map(
    ({ axis, level, rationale }) => ({ axis, level, rationale }),
  );

  const overallLevel = resolveOverallLevel(axes);
  const acceptanceDisposition = resolveAcceptanceDisposition(
    axes,
    overallLevel,
  );
  const requiresReview = resolveRequiresReview(overallLevel, axes);
  const gateDecision = requiresReview ? 'review-required' : 'auto-proceed';

  return {
    axes,
    overallLevel,
    requiresReview,
    acceptanceDisposition,
    gateDecision,
  };
}
