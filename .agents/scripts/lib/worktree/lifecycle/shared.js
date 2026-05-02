/**
 * worktree/lifecycle/shared.js
 *
 * Argument validators reused by every lifecycle submodule. Pure: no fs, no
 * git, no ctx.
 */

const STORY_BRANCH_RE = /^story-\d+$/;

export function validateStoryId(storyId) {
  const n =
    typeof storyId === 'number' ? storyId : Number.parseInt(storyId, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`WorktreeManager: invalid storyId: ${storyId}`);
  }
  return n;
}

export function validateBranch(branch) {
  if (typeof branch !== 'string' || !STORY_BRANCH_RE.test(branch)) {
    throw new Error(
      `WorktreeManager: branch must match ${STORY_BRANCH_RE}, got: ${branch}`,
    );
  }
  return branch;
}
