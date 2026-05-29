/**
 * worktree/inspector.js
 *
 * Read-only parsing and path helpers for the worktree subsystem. Pure-ish:
 * callers inject `platform` and pass absolute paths explicitly. No fs
 * mutation; no git invocation (parsing only). One log side-effect in
 * `maybeWarnWindowsPath` via the injected logger.
 */

import path from 'node:path';
import { parseStoryBranch } from '../git-utils.js';

/**
 * Parse `git worktree list --porcelain` output into records.
 *
 * Porcelain format: blank-line-separated blocks where each line is
 * `key value` or a bare key (e.g. `bare`, `detached`).
 *
 * @param {string} raw
 * @returns {Array<{ path: string, head: string|null, branch: string|null, bare: boolean, detached: boolean }>}
 */
export function parseWorktreePorcelain(raw) {
  const out = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) continue;
    const rec = {
      path: '',
      head: null,
      branch: null,
      bare: false,
      detached: false,
    };
    for (const line of lines) {
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? '' : line.slice(sp + 1);
      switch (key) {
        case 'worktree':
          rec.path = value;
          break;
        case 'HEAD':
          rec.head = value;
          break;
        case 'branch':
          rec.branch = value.replace(/^refs\/heads\//, '');
          break;
        case 'bare':
          rec.bare = true;
          break;
        case 'detached':
          rec.detached = true;
          break;
      }
    }
    if (rec.path) out.push(rec);
  }
  return out;
}

/**
 * Path equality that handles Windows case-insensitivity and path
 * normalization differences.
 *
 * @param {string} a
 * @param {string} b
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
export function samePath(a, b, platform) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/**
 * Extract `<id>` from a `<worktreeRoot>/story-<id>` path, or `null` if the
 * path is not a managed story worktree.
 *
 * @param {string} wtPath
 * @param {string} worktreeRoot
 * @returns {number|null}
 */
export function storyIdFromPath(wtPath, worktreeRoot) {
  const resolved = path.resolve(wtPath);
  const rel = path.relative(worktreeRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return parseStoryBranch(rel);
}

/**
 * True if `candidate` is the same path as `wtPath` or nested beneath it.
 *
 * @param {string} candidate
 * @param {string} wtPath
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
export function isInsideWorktree(candidate, wtPath, platform) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedWt = path.resolve(wtPath);
  if (samePath(resolvedCandidate, resolvedWt, platform)) return true;
  const rel = path.relative(resolvedWt, resolvedCandidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Warn when the anticipated deepest path under a fresh worktree crosses the
 * configured threshold on Windows. Returns the warning payload when a warning
 * was emitted, or `null` otherwise.
 *
 * @param {{ platform: NodeJS.Platform, threshold?: number, logger: { warn: (m: string) => void } }} ctx
 * @param {string} wtPath
 * @returns {{ path: string, length: number, threshold: number } | null}
 */
export function maybeWarnWindowsPath(ctx, wtPath) {
  if (ctx.platform !== 'win32') return null;
  // Defense-in-depth: callers on the worktree-off branch never compute a
  // worktree path, so this should never be invoked with a falsy `wtPath`.
  // Guard anyway so a future refactor that drops the gating can't trigger
  // an `undefined.length` crash here.
  if (typeof wtPath !== 'string' || wtPath.length === 0) return null;
  const threshold = ctx.threshold ?? 240;
  // Approximate the deepest path an agent is likely to touch: worktree
  // root + a conservative project-depth allowance. 80 chars covers the
  // common case of `apps/<name>/src/<module>/<file>.ts` and similar
  // monorepo layouts without requiring tech-stack config wiring.
  const deepestAllowance = 80;
  const estimated = wtPath.length + deepestAllowance;
  if (estimated <= threshold) return null;
  ctx.logger.warn(
    `windows-long-path path=${wtPath} length=${wtPath.length} estimated=${estimated} threshold=${threshold}`,
  );
  return { path: wtPath, length: estimated, threshold };
}
