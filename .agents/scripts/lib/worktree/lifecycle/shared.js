/**
 * worktree/lifecycle/shared.js
 *
 * Argument validators reused by every lifecycle submodule. Pure: no fs, no
 * git, no ctx.
 */

import { isStoryBranch } from '../../git-utils.js';

export function validateStoryId(storyId) {
  const n =
    typeof storyId === 'number' ? storyId : Number.parseInt(storyId, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`WorktreeManager: invalid storyId: ${storyId}`);
  }
  return n;
}

export function validateBranch(branch) {
  if (!isStoryBranch(branch)) {
    throw new Error(
      `WorktreeManager: branch must match /^story-\\d+$/, got: ${branch}`,
    );
  }
  return branch;
}
