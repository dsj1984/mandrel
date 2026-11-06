import { runPostLandTail as defaultRunPostLandTail } from '../orchestration/single-story-close/phases/post-land.js';
import { confirmStoryMerged } from './confirm-merge.js';

/** The confirm arguments the land tail also takes. */
function landTailArgs({ storyId, prNumber, prUrl, injectedGh, ...rest }) {
  const { cwd, provider, config, progress } = rest;
  return {
    storyId,
    prNumber,
    prUrl,
    gh: injectedGh,
    cwd,
    provider,
    config,
    progress,
  };
}

/**
 * Confirm, then the land tail when merged — shared by every merged-Story
 * path, since a flip alone strands the lease and worktree.
 *
 * @param {object} args  {@link confirmStoryMerged}'s arguments, plus:
 * @param {string} args.storyBranch
 * @param {string} [args.baseBranch] Defaults to `project.baseBranch`.
 * @param {Function} [args.runPostLandTailFn] Test seam.
 * @returns {Promise<{ confirmation: object, tail: object|null }>}
 */
export async function confirmAndLand({
  storyBranch,
  baseBranch,
  runPostLandTailFn = defaultRunPostLandTail,
  ...confirmArgs
}) {
  const confirmation = await confirmStoryMerged(confirmArgs);
  if (confirmation.merged !== true) return { confirmation, tail: null };
  const tail = await runPostLandTailFn({
    ...landTailArgs(confirmArgs),
    storyBranch,
    baseBranch: baseBranch ?? confirmArgs.config?.project?.baseBranch ?? 'main',
  });
  return { confirmation, tail };
}
