/**
 * plan-review-routing.js — resolve Phase 7 review-stop vs auto-proceed.
 *
 * Pure ESM, no I/O. Consumes the shared planningRisk envelope (derived
 * from the planner-authored risk verdict via `deriveRiskEnvelope`) and
 * optional operator overrides to decide whether the plan wrapper should
 * STOP for human review before Phase 8.
 */

/**
 * @typedef {import('./planning-risk.js').PlanningRiskEnvelope} PlanningRiskEnvelope
 * @typedef {'review-required' | 'auto-proceed' | 'operator-override-review'} ReviewRoutingDecision
 */

/**
 * @typedef {Object} ReviewRoutingEnvelope
 * @property {ReviewRoutingDecision} decision
 * @property {boolean} requiresStop
 * @property {boolean} forceReviewApplied
 * @property {string} operatorMessage
 */

const AUTO_PROCEED_MESSAGE =
  'Planning risk is low — auto-proceeding to Phase 8 decomposition after spec validation. Context tickets remain open until Epic delivery finalizes.';

const REVIEW_REQUIRED_MESSAGE =
  'Planning risk requires operator review — STOP before Phase 8. Review the Tech Spec sections and the Acceptance Table — both managed sections of the Epic body — on GitHub and confirm in this session before decomposition.';

const FORCE_REVIEW_MESSAGE =
  'Operator override — forcing review stop before Phase 8 despite low planning risk.';

/**
 * Resolve whether Phase 7 should STOP for operator review before Phase 8.
 *
 * @param {{ planningRisk: PlanningRiskEnvelope, forceReview?: boolean }} input
 * @returns {ReviewRoutingEnvelope}
 */
export function resolveReviewRouting({ planningRisk, forceReview = false }) {
  if (forceReview) {
    return {
      decision: 'operator-override-review',
      requiresStop: true,
      forceReviewApplied: true,
      operatorMessage: FORCE_REVIEW_MESSAGE,
    };
  }

  if (planningRisk.requiresReview) {
    return {
      decision: 'review-required',
      requiresStop: true,
      forceReviewApplied: false,
      operatorMessage: REVIEW_REQUIRED_MESSAGE,
    };
  }

  return {
    decision: 'auto-proceed',
    requiresStop: false,
    forceReviewApplied: false,
    operatorMessage: AUTO_PROCEED_MESSAGE,
  };
}
