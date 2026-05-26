/**
 * phases/push.js — push the Story branch to origin.
 *
 * `git push -u` makes the local branch track origin/story-<id> so
 * subsequent fetches are cheap. A push failure raises so the caller
 * fails non-zero — the operator must resolve before retrying.
 *
 * `gitSync` is accepted as an injected dependency rather than statically
 * imported so the caller's (cache-busted) binding wins. The
 * `single-story-close.js` orchestrator owns the static import; test
 * suites mock the git-utils module URL and re-import the SUT to refresh
 * the binding it passes in.
 */

import { gitSync as defaultGitSync } from '../../../git-utils.js';

/**
 * Push the Story branch with `-u` so the upstream is set.
 *
 * @param {{
 *   cwd: string,
 *   storyBranch: string,
 *   gitSync?: typeof defaultGitSync,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 */
export function pushStoryBranch({
  cwd,
  storyBranch,
  gitSync = defaultGitSync,
  progress,
}) {
  progress('GIT', `Pushing ${storyBranch} to origin...`);
  try {
    gitSync(cwd, 'push', '--no-verify', '-u', 'origin', storyBranch);
    progress('GIT', `✅ Pushed ${storyBranch}.`);
  } catch (err) {
    throw new Error(
      `[single-story-close] git push failed for ${storyBranch}: ${err?.message ?? err}`,
    );
  }
}
