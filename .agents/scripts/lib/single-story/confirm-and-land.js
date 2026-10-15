/**
 * confirm-and-land.js — the one confirm-and-land pairing every merged-Story
 * path runs: the confirm-merge CLI's single probe, the boot sweep, and close's
 * already-closed early return. A flip without the land tail strands the
 * operator's lease, the worktree and the Epic rollup.
 */

import { runPostLandTail as defaultRunPostLandTail } from '../orchestration/single-story-close/phases/post-land.js';
import { confirmStoryMerged } from './confirm-merge.js';

/**
 * {@link confirmStoryMerged}, then the land tail gated on `merged`, not
 * `action === 'done'`: an already-done Story (`noop`, merged) still needs the
 * belated backfill. Every tail step is idempotent; the tail never throws.
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
