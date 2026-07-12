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
 * @property {string} [acceptanceWaivedReason] Present only when the
 *   acceptance disposition was forced to `not-applicable` by a non-axis
 *   signal (currently: no BDD runner detected). An operator-visible
 *   rationale so the override is never silent (Story #4145).
 */

/**
 * @typedef {Object} BddRunnerProbe
 * @property {string|null} runner
 * @property {boolean} fallback `true` when no supported BDD runner was
 *   detected in the project (`verifyBddRunnerPendingTag`).
 * @property {string} [reason]
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
 * (`plan-persist.js` via `loadRiskVerdict`), never here, so a malformed verdict fails closed
 * before this function runs.
 *
 * **No-BDD-runner waiver (Story #4145).** The acceptance disposition the risk
 * axes derive presumes a BDD runner exists to satisfy an authored AC table.
 * When `opts.bddRunner.fallback === true` (no supported runner detected — e.g.
 * a `node:test` repo with no `tests/features/**`), an authored AC table can
 * never be reconciled by `@epic-<id>-ac-*` feature tags, so `/deliver`
 * finalize would abort. In that case the disposition is **forced** to
 * `not-applicable` regardless of the risk axes, and `acceptanceWaivedReason`
 * records the override so it is operator-visible, not silent. The
 * `requiresReview` / `gateDecision` outputs are unaffected — a high-risk
 * Epic still routes to review; only the acceptance-spec requirement is
 * waived. Repos that ship a BDD runner (`fallback !== true`) are unaffected.
 *
 * @param {RiskVerdict} [verdict]
 * @param {{ bddRunner?: BddRunnerProbe|null }} [opts]
 * @returns {PlanningRiskEnvelope}
 */
export function deriveRiskEnvelope(verdict = {}, { bddRunner = null } = {}) {
  const axes = (Array.isArray(verdict.axes) ? verdict.axes : []).map(
    ({ axis, level, rationale }) => ({ axis, level, rationale }),
  );

  const overallLevel = resolveOverallLevel(axes);
  const axisDisposition = resolveAcceptanceDisposition(axes, overallLevel);
  const requiresReview = resolveRequiresReview(overallLevel, axes);
  const gateDecision = requiresReview ? 'review-required' : 'auto-proceed';

  const noBddRunner = bddRunner?.fallback === true;
  // Force the waiver only when the axes would otherwise have required (or
  // recommended) an AC table; if the disposition is already not-applicable
  // there is nothing to override and no waiver rationale to surface.
  const forceWaiver = noBddRunner && axisDisposition !== 'not-applicable';
  const acceptanceDisposition = forceWaiver
    ? 'not-applicable'
    : axisDisposition;

  /** @type {PlanningRiskEnvelope} */
  const envelope = {
    axes,
    overallLevel,
    requiresReview,
    acceptanceDisposition,
    gateDecision,
  };
  if (forceWaiver) {
    envelope.acceptanceWaivedReason =
      `no BDD runner detected (${bddRunner?.reason ?? 'no-bdd-runner-detected'}) — ` +
      `an authored acceptance-spec AC table cannot be reconciled by feature tags, ` +
      `so the acceptance disposition is waived to not-applicable (was ${axisDisposition}).`;
  }
  return envelope;
}
