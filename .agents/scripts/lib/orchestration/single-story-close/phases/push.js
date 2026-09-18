/**
 * phases/push.js — push the Story branch to origin.
 *
 * `git push` exits 0 only once origin accepted the ref, so the throw is the
 * origin assertion every later phase depends on. It runs from the worktree:
 * `core.hooksPath` is relative, so the invocation directory decides which
 * tree `pre-push` measures (the main checkout gave false greens). With no
 * worktree, the main checkout is the pushed tree.
 */

import { gitSync as defaultGitSync } from '../../../git-utils.js';

/**
 * @param {{
 *   cwd: string,
 *   worktreePath?: string|null,
 *   storyBranch: string,
 *   gitSync?: typeof defaultGitSync,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 */
export function pushStoryBranch({
  cwd,
  worktreePath = null,
  storyBranch,
  gitSync = defaultGitSync,
  progress,
}) {
  progress('GIT', `Pushing ${storyBranch} to origin...`);
  try {
    // Never bypass hooks: under `--skip-validation`, `pre-push` is the only gate.
    gitSync(worktreePath ?? cwd, 'push', '-u', 'origin', storyBranch);
    progress('GIT', `✅ Pushed ${storyBranch}.`);
  } catch (err) {
    throw new Error(
      `[single-story-close] git push failed for ${storyBranch}: ${err?.message ?? err}`,
    );
  }
}
