import { runPostLandTail as defaultRunPostLandTail } from '../orchestration/single-story-close/phases/post-land.js';
import { confirmStoryMerged } from './confirm-merge.js';

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
  const { storyId, cwd, provider, config, progress } = confirmArgs;
  const tail = await runPostLandTailFn({
    storyId,
    storyBranch,
    baseBranch: baseBranch ?? config?.project?.baseBranch ?? 'main',
    cwd,
    provider,
    config,
    progress,
  });
  return { confirmation, tail };
}
