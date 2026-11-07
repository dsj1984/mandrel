import { emitReviewBlockedFriction } from '../../../observability/close-telemetry.js';
import { handleCriticalReviewBlock } from './review-block.js';
import { handleOverriddenReviewBlock } from './review-override.js';

/**
 * The thrown message for a halt: a critical count, or the no-verdict blocker.
 *
 * @param {{ prUrl: string, criticalCount: number, noVerdictReason: string|null }} args
 * @returns {string}
 */
function haltMessage({ prUrl, criticalCount, noVerdictReason }) {
  const head = noVerdictReason
    ? `[single-story-close] Story-scope review produced no verdict on PR ${prUrl}: ${noVerdictReason} ` +
      'Auto-merge was not enabled. '
    : `[single-story-close] Story-scope review reported ${criticalCount} critical blocker(s) on PR ${prUrl}. ` +
      'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/mandrel-deliver`. ';
  return (
    head +
    'If you have reviewed a finding and judged it wrong, re-run with ' +
    '`--override-review-block "<reason>"` rather than merging by hand.'
  );
}

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
  const noVerdictReason =
    reviewOutcome.haltCause === 'no-verdict'
      ? (reviewOutcome.blockerReason ?? 'no verdict')
      : null;
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
      noVerdictReason,
      findings: reviewOutcome.findings ?? [],
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
    noVerdictReason,
  });
  throw new Error(haltMessage({ prUrl, criticalCount, noVerdictReason }));
}
