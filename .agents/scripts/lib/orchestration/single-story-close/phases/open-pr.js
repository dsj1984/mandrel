import { Logger } from '../../../Logger.js';
import { discardHeldReview, reviewAfterPrOpen } from '../review-overlap.js';
import { parsePrNumber } from './code-review.js';
import { ensurePullRequestWith } from './pull-request.js';
import { pushStoryBranch } from './push.js';
import { resolveReviewHalt } from './review-halt.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

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
