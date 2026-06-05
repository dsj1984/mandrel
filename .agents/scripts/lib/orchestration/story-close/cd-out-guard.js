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
 * Both operands are canonicalized through `fs.realpathSync` before the
 * equality check (Story #3672). `path.resolve` normalizes `.`/`..` and makes
 * a path absolute but does NOT resolve symlinks, while `process.cwd()` is
 * returned fully canonicalized by the OS. On hosts where the working path
 * contains a symlinked component — most notably macOS, where `/tmp` →
 * `/private/tmp` and `/var` → `/private/var` — the two strings would never
 * match, so the guard silently no-opped and failed to fire. Realpath'ing
 * both sides closes that false-negative.
 *
 * Pure: takes inputs, returns a verdict. Exported so the rejection path is
 * unit-testable without spawning the script. The `realpath` seam is injected
 * (default `fs.realpathSync`) so tests can drive the symlinked and
 * non-symlinked cases without touching the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonicalize a path: resolve symlinks via `realpath`, falling back to
 * `path.resolve` when the path does not exist yet (`realpathSync` throws on
 * missing paths). The fallback keeps the comparison correct for
 * not-yet-created worktree directories.
 *
 * @param {string} p
 * @param {(p: string) => string} realpath
 * @returns {string}
 */
function canonical(p, realpath) {
  try {
    return realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {object} opts
 * @param {boolean} opts.cwdExplicit       True when `--cwd` (or AGENT_WORKTREE_ROOT) was set.
 * @param {string} opts.mainCwd            Resolved main repo path.
 * @param {number|string} opts.storyId
 * @param {string} [opts.worktreeRoot]     `delivery.worktreeIsolation.root` (defaults to `.worktrees`).
 * @param {string} [opts.currentCwd]       Defaults to `process.cwd()`.
 * @param {(p: string) => string} [opts.realpath]  Symlink-resolution seam (defaults to `fs.realpathSync`).
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkCdOutGuard({
  cwdExplicit,
  mainCwd,
  storyId,
  worktreeRoot = '.worktrees',
  currentCwd = process.cwd(),
  realpath = fs.realpathSync,
}) {
  if (!cwdExplicit) return { ok: true };
  const workCwd = canonical(
    path.resolve(mainCwd, worktreeRoot, `story-${storyId}`),
    realpath,
  );
  const cwd = canonical(currentCwd, realpath);
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
