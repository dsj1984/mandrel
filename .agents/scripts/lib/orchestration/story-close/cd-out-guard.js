/**
 * cd-out-guard.js — pre-flight check that refuses to close while the
 * operator's shell is still cd'd into the per-story worktree being reaped.
 *
 * Extracted from story-close.js (Story #956, Theme A finishing touch) so the
 * close orchestrator becomes a thin CLI shell.
 *
 * On Windows this surfaces as `EBUSY: resource busy or locked, rmdir`
 * during reap; cross-platform it makes `--cwd` semantics impossible to
 * honour because git operations target the main repo while the filesystem
 * mutation targets the worktree the caller is sitting inside.
 *
 * Fires only when `--cwd` is set explicitly. Single-tree closures resolve
 * `workCwd` to the main repo, so the equality check is a tautology there
 * and we don't reject those.
 *
 * Pure: takes inputs, returns a verdict. Exported so the rejection path is
 * unit-testable without spawning the script.
 */

import path from 'node:path';

/**
 * @param {object} opts
 * @param {boolean} opts.cwdExplicit       True when `--cwd` (or AGENT_WORKTREE_ROOT) was set.
 * @param {string} opts.mainCwd            Resolved main repo path.
 * @param {number|string} opts.storyId
 * @param {string} [opts.worktreeRoot]     `delivery.worktreeIsolation.root` (defaults to `.worktrees`).
 * @param {string} [opts.currentCwd]       Defaults to `process.cwd()`.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkCdOutGuard({
  cwdExplicit,
  mainCwd,
  storyId,
  worktreeRoot = '.worktrees',
  currentCwd = process.cwd(),
}) {
  if (!cwdExplicit) return { ok: true };
  const workCwd = path.resolve(mainCwd, worktreeRoot, `story-${storyId}`);
  const cwd = path.resolve(currentCwd);
  if (cwd !== workCwd) return { ok: true };
  return {
    ok: false,
    message:
      `Refusing to close while CWD is the worktree being reaped.\n` +
      `   Current cwd:  ${cwd}\n` +
      `   Main repo:    ${mainCwd}\n` +
      `   Run instead:  cd "${mainCwd}" && node .agents/scripts/story-close.js --story ${storyId}`,
  };
}
