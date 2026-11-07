import { Logger } from '../../../Logger.js';
import { discardHeldReview, reviewAfterPrOpen } from '../review-overlap.js';
import { parsePrNumber } from './code-review.js';
import { ensurePullRequestWith } from './pull-request.js';
import { pushStoryBranch } from './push.js';
import { resolveReviewHalt } from './review-halt.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/** What `ensurePullRequestWith` needs from the close context. */
function pullRequestArgs(ctx, deps) {
  const { options, story, storyId, storyBranch, baseBranch, prePush } = ctx;
  return {
    cwd: options.cwd,
    storyId,
    storyTitle: story.title,
    storyBody: story.body,
    storyBranch,
    baseBranch,
    config: deps.config,
    gh: deps.gh,
    progress,
    coverageDeferred: prePush.coverageDeferred,
  };
}

/** Push from the worktree so `pre-push` measures the tree being sent. */
function pushPhase(ctx, deps) {
  ctx.setPhase('push');
  return pushStoryBranch({
    cwd: ctx.options.cwd,
    worktreePath: ctx.worktreePath,
    storyBranch: ctx.storyBranch,
    skipValidation: ctx.options.skipValidation,
    gitSync: deps.git.gitSync,
    gitSpawn: deps.git.gitSpawn,
    progress,
  }).outcome;
}

export async function openAndReviewPr(ctx, deps) {
  const { options, storyId, storyBranch, baseBranch } = ctx;
  const { cwd } = options;
  // The ref-based reads below resolve identically from the shared `.git`.
  const pushOutcome = pushPhase(ctx, deps);
  ctx.setPhase('pull-request');
  const { url: prUrl, alreadyMerged } = await ensurePullRequestWith(
    pullRequestArgs(ctx, deps),
  );
  const prNumber = parsePrNumber(prUrl);
  ctx.recordPrNumber(prNumber);
  // Already merged (landed between invocations): skip review and arm; confirm observes it.
  if (alreadyMerged) {
    discardHeldReview(ctx.heldReview, 'PR already merged', progress);
    return {
      prUrl,
      prNumber,
      alreadyMerged: true,
      pushOutcome,
      reviewSkipped: true,
    };
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
    config: deps.config,
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
    pushOutcome,
    reviewOverride,
    reviewDegradations: reviewOutcome.degradations ?? [],
  };
}
