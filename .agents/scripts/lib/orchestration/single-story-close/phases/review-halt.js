import { emitReviewBlockedFriction } from '../../../observability/close-telemetry.js';
import { handleCriticalReviewBlock } from './review-block.js';
import { handleOverriddenReviewBlock } from './review-override.js';

/**
 * An overridden Story proceeds; anything else emits friction, blocks, throws.
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {{ prUrl: string, prNumber: number|null, reviewOutcome: object }} pr
 * @returns {Promise<object>}
 */
export async function resolveReviewHalt(
  ctx,
  deps,
  { prUrl, prNumber, reviewOutcome },
) {
  const { storyId } = ctx;
  const criticalCount = reviewOutcome.severity?.critical ?? 0;
  // Checked before the blocked transition: an overridden Story proceeds.
  if (ctx.options.overrideReviewBlock) {
    return await handleOverriddenReviewBlock({
      provider: deps.provider,
      storyId,
      prUrl,
      prNumber,
      criticalCount,
      criticalByProvider: reviewOutcome.criticalByProvider,
      reason: ctx.options.overrideReviewBlock,
      config: deps.config,
    });
  }
  await emitReviewBlockedFriction({
    storyId,
    prNumber,
    criticalCount,
    criticalByProvider: reviewOutcome.criticalByProvider,
    config: deps.config,
  });
  await handleCriticalReviewBlock({
    provider: deps.provider,
    storyId,
    prUrl,
    criticalCount,
  });
  throw new Error(
    `[single-story-close] Story-scope review reported ${criticalCount} critical blocker(s) on PR ${prUrl}. ` +
      'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/mandrel-deliver`. ' +
      'If you have reviewed a finding and judged it wrong, re-run with ' +
      '`--override-review-block "<reason>"` rather than merging by hand.',
  );
}
