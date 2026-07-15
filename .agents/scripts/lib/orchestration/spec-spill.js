/**
 * v2 Story `## Spec` budget gate.
 *
 * The Story body is the single executable document: Tech Spec prose stays
 * inline under `## Spec`. There is no spill-to-`docs/` path — an over-budget
 * Spec is treated as a sizing smell (the Story should be split or the Spec
 * tightened), not as a reason to write temporary product docs.
 *
 * The budget reuses the §2 FinOps estimator ({@link estimateTokens}, ~4
 * chars/token) so the threshold speaks the same units as hydration budgets.
 *
 * @module lib/orchestration/spec-spill
 */

import { estimateTokens } from './context-envelope.js';

/**
 * Soft budget (estimated tokens) for an inline `## Spec`. ~1500 tokens ≈ 6KB —
 * enough for a real approach section, well under issue-body bloat.
 */
export const DEFAULT_SPEC_BODY_TOKEN_BUDGET = 1500;

/**
 * @typedef {object} SpecBudgetResult
 * @property {number} estimatedTokens
 * @property {string} content
 */

/**
 * Keep Spec inline when it fits; throw when it exceeds the budget so the
 * planner splits or tightens instead of writing docs/.
 *
 * @param {object} args
 * @param {string} args.storyId  Story slug/id for error context.
 * @param {string} args.spec     Folded Tech Spec markdown.
 * @param {object} [opts]
 * @param {number} [opts.tokenBudget=DEFAULT_SPEC_BODY_TOKEN_BUDGET]
 * @returns {SpecBudgetResult}
 */
export function assertSpecWithinBudget({ storyId, spec }, opts = {}) {
  const { tokenBudget = DEFAULT_SPEC_BODY_TOKEN_BUDGET } = opts;
  const content = typeof spec === 'string' ? spec : '';
  const estimatedTokens = estimateTokens(content);

  if (estimatedTokens <= tokenBudget) {
    return { estimatedTokens, content };
  }

  const label =
    typeof storyId === 'string' && storyId.trim() !== ''
      ? storyId.trim()
      : 'unknown';

  throw new Error(
    `[plan-persist] Story "${label}" ## Spec is ~${estimatedTokens} tokens ` +
      `(budget ${tokenBudget}). An over-budget Spec usually means the Story ` +
      `is too large — split it, or tighten ## Spec so the Story body stays ` +
      `the single executable document. Specs are never written to docs/.`,
  );
}
