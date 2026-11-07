/**
 * phases/push.js — push the Story branch to origin.
 *
 * `git push` exits 0 only once origin accepted the ref, so the throw is the
 * origin assertion every later phase depends on. It runs from the worktree:
 * `core.hooksPath` is relative, so the invocation directory decides which
 * tree `pre-push` measures (the main checkout gave false greens). With no
 * worktree, the main checkout is the pushed tree.
 * A no-op push still starts `pre-push`, so origin already at the tip skips.
 */

import { remoteBranchSha } from '../../../git-branch-lifecycle.js';
import {
  gitSpawn as defaultGitSpawn,
  gitSync as defaultGitSync,
} from '../../../git-utils.js';

function localTip(cwd, branch, gitSpawn) {
  const res = gitSpawn(cwd, 'rev-parse', `refs/heads/${branch}`);
  return res?.status === 0 ? `${res.stdout ?? ''}`.trim() || null : null;
}

function originAtLocalTip(cwd, branch, gitSpawn) {
  try {
    const sha = localTip(cwd, branch, gitSpawn);
    const remote = sha && remoteBranchSha(cwd, branch, gitSpawn);
    return Boolean(remote?.reachable && remote.sha === sha);
  } catch {
    return false;
  }
}

function push(cwd, storyBranch, gitSync, progress) {
  progress('GIT', `Pushing ${storyBranch} to origin...`);
  try {
    // Never bypass hooks: under `--skip-validation`, `pre-push` is the only gate.
    gitSync(cwd, 'push', '-u', 'origin', storyBranch);
    progress('GIT', `✅ Pushed ${storyBranch}.`);
  } catch (err) {
    throw new Error(
      `[single-story-close] git push failed for ${storyBranch}: ${err?.message ?? err}`,
    );
  }
  return { outcome: 'pushed' };
}

/**
 * @param {{
 *   cwd: string,
 *   worktreePath?: string|null,
 *   storyBranch: string,
 *   skipValidation?: boolean,
 *   gitSync?: typeof defaultGitSync,
 *   gitSpawn?: typeof defaultGitSpawn,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {{ outcome: 'pushed'|'skipped-already-at-head' }}
 */
export function pushStoryBranch({
  cwd,
  worktreePath = null,
  storyBranch,
  skipValidation = false,
  gitSync = defaultGitSync,
  gitSpawn = defaultGitSpawn,
  progress,
}) {
  const pushCwd = worktreePath ?? cwd;
  if (skipValidation || !originAtLocalTip(pushCwd, storyBranch, gitSpawn)) {
    return push(pushCwd, storyBranch, gitSync, progress);
  }
  progress('GIT', `⏭  origin/${storyBranch} already at HEAD — push skipped.`);
  return { outcome: 'skipped-already-at-head' };
}
