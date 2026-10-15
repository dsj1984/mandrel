import { runPostLandTail as defaultRunPostLandTail } from '../orchestration/single-story-close/phases/post-land.js';
import { confirmStoryMerged } from './confirm-merge.js';

/**
 * The one pairing every merged-Story path runs (confirm CLI, boot sweep,
 * close's already-closed return): confirm, then the land tail gated on
 * `merged` — a flip alone strands the lease, worktree and Epic rollup.
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
