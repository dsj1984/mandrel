import { Logger } from '../../../Logger.js';
import { emitReviewBlockedFriction } from '../../../observability/close-telemetry.js';
import { discardHeldReview, reviewAfterPrOpen } from '../review-overlap.js';
import { parsePrNumber } from './code-review.js';
import { ensurePullRequestWith } from './pull-request.js';
import { pushStoryBranch } from './push.js';
import { handleCriticalReviewBlock } from './review-block.js';
import { handleOverriddenReviewBlock } from './review-override.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * An overridden Story proceeds; anything else emits friction, blocks, throws.
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {{ prUrl: string, prNumber: number|null, reviewOutcome: object }} pr
 * @returns {Promise<object>}
 */
async function resolveReviewHalt(
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

export async function openAndReviewPr(ctx, deps) {
  const { options, worktreePath, story, storyId, storyBranch, baseBranch } =
    ctx;
  const { cwd } = options;
  ctx.setPhase('push');
  // Push from the worktree so `pre-push` measures the tree being sent; the
  // ref-based reads below resolve identically from the shared `.git`.
  pushStoryBranch({
    cwd,
    worktreePath,
    storyBranch,
    gitSync: deps.git.gitSync,
    progress,
  });
  ctx.setPhase('pull-request');
  const { url: prUrl, alreadyMerged } = await ensurePullRequestWith({
    cwd,
    storyId,
    storyTitle: story.title,
    storyBody: story.body,
    storyBranch,
    baseBranch,
    gh: deps.gh,
    progress,
  });
  const prNumber = parsePrNumber(prUrl);
  ctx.recordPrNumber(prNumber);
  // Already merged (landed between invocations): skip review and arm; confirm observes it.
  if (alreadyMerged) {
    discardHeldReview(ctx.heldReview, 'PR already merged', progress);
    return { prUrl, prNumber, alreadyMerged: true };
  }
  const reviewOutcome = await reviewAfterPrOpen({
    held: ctx.heldReview,
    cwd,
    storyId,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    provider: deps.provider,
    runCodeReviewFn: deps.runCodeReview,
    gitSpawnFn: deps.git.gitSpawn,
    progress,
    setPhase: ctx.setPhase,
    pauseTimer: ctx.phaseTimer.pause,
    recordDuration: ctx.phaseTimer.record,
  });
  const reviewOverride = reviewOutcome.halted
    ? await resolveReviewHalt(ctx, deps, { prUrl, prNumber, reviewOutcome })
    : null;
  return {
    prUrl,
    prNumber,
    alreadyMerged: false,
    reviewOverride,
    reviewDegraded: reviewOutcome.degraded === true,
  };
}
