/** Git-derived roots; Node builtins only, since doctor imports it. */

import fs from 'node:fs';
import path from 'node:path';

import { execFileCapture } from '../child-exec.js';
import { PROJECT_ROOT } from '../project-root.js';

const GIT_QUIET = { stdio: ['ignore', 'pipe', 'ignore'] };

const _cache = new Map();

/** Memoized per flag and cwd for the real runner; `null` outside a repo. */
function revParse(flag, cwd, exec) {
  const key = `${flag}\0${cwd}`;
  if (!exec && _cache.has(key)) return _cache.get(key);
  let out = null;
  try {
    const opts = { cwd, ...GIT_QUIET, ...(exec ? { run: exec } : {}) };
    out = execFileCapture('git', ['rev-parse', flag], opts).trim() || null;
  } catch {
    out = null;
  }
  if (!exec) _cache.set(key, out);
  return out;
}

/** Parent of `--git-common-dir`: the main checkout, from any worktree. */
export function mainCheckoutRoot(cwd = process.cwd(), deps = {}) {
  const out = revParse('--git-common-dir', cwd, deps.exec);
  if (!out) return null;
  return path.dirname(path.isAbsolute(out) ? out : path.resolve(cwd, out));
}

/** This work tree's own root — a linked worktree's, not the main one's. */
function gitToplevel(cwd, exec) {
  return revParse('--show-toplevel', cwd, exec);
}

/**
 * Where `.agentrc.json` is read: `cwd` → `AP_AGENTRC_CWD` → the process
 * cwd's git toplevel → `PROJECT_ROOT`.
 */
export function resolveAgentrcRoot({
  cwd,
  env = process.env,
  processCwd = process.cwd,
  exec,
} = {}) {
  if (cwd) return path.resolve(cwd);
  if (env.AP_AGENTRC_CWD) return path.resolve(env.AP_AGENTRC_CWD);
  return path.resolve(gitToplevel(processCwd(), exec) ?? PROJECT_ROOT);
}

/**
 * The dir whose `.agentrc.local.json` overlays `root`: `root` when it has
 * one or is not a work tree's root, else the main checkout — a gitignored
 * overlay is not copied into a plain `git worktree add`.
 */
export function overlayRoot(root, exec) {
  if (fs.existsSync(path.join(root, '.agentrc.local.json'))) return root;
  return gitToplevel(root, exec) === root
    ? mainCheckoutRoot(root, { exec })
    : root;
}

/** Test-only. */
export function _clearGitRootCaches() {
  _cache.clear();
}
