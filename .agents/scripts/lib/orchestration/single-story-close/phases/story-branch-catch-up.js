/**
 * phases/story-branch-catch-up.js — keep the Story worktree's branch level
 * with `origin/story-<id>` before close or the merge wait pushes from it.
 */

import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';

/**
 * Bring the worktree's branch up to `origin/<branch>`: a remote
 * `gh pr update-branch` merge lands only there, and a push from behind it is
 * rejected. `ffOnly` never creates a merge; a failed merge is aborted.
 *
 * @returns {{ ok: boolean, skipped?: boolean, stderr?: string }}
 */
export function integrateRemoteStoryBranch({
  cwd,
  storyBranch,
  gitSpawn = defaultGitSpawn,
  ffOnly = false,
}) {
  const fetched = gitSpawn(cwd, 'fetch', 'origin', storyBranch);
  if (fetched.status !== 0) return { ok: true, skipped: true };
  const mode = ffOnly ? '--ff-only' : '--no-edit';
  const merged = gitSpawn(cwd, 'merge', mode, `origin/${storyBranch}`);
  if (merged.status === 0) return { ok: true };
  if (!ffOnly) gitSpawn(cwd, 'merge', '--abort');
  return { ok: false, stderr: String(merged.stderr ?? '') };
}

/** Best-effort ff-only catch-up; a refusal is one warning line. */
export function catchUpWithOrigin({
  worktreePath,
  storyBranch,
  gitSpawn,
  progress,
}) {
  const caught = integrateRemoteStoryBranch({
    cwd: worktreePath,
    storyBranch,
    gitSpawn,
    ffOnly: true,
  });
  if (!caught.ok) {
    progress(
      'WORKTREE',
      `⚠️ ${storyBranch} could not fast-forward to origin/${storyBranch}: ${caught.stderr.trim()}`,
    );
  }
  return worktreePath;
}
