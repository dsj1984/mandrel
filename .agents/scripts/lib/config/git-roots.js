/** Git-derived roots; Node builtins only, since doctor imports it. */

import path from 'node:path';

import { execFileCapture } from '../child-exec.js';
import { PROJECT_ROOT } from '../project-root.js';

const GIT_QUIET = { stdio: ['ignore', 'pipe', 'ignore'] };

const _mainCheckoutRootCache = new Map();
const _toplevelCache = new Map();

/** Memoized per cwd for the real runner; `null` outside a repo. */
function revParse(flag, cwd, cache, exec) {
  if (!exec && cache.has(cwd)) return cache.get(cwd);
  let out = null;
  try {
    out =
      execFileCapture('git', ['rev-parse', flag], {
        cwd,
        ...GIT_QUIET,
        ...(exec ? { run: exec } : {}),
      }).trim() || null;
  } catch {
    out = null;
  }
  if (!exec) cache.set(cwd, out);
  return out;
}

/** Parent of `--git-common-dir`: the main checkout, from any worktree. */
export function mainCheckoutRoot(cwd = process.cwd(), deps = {}) {
  const out = revParse(
    '--git-common-dir',
    cwd,
    _mainCheckoutRootCache,
    deps.exec,
  );
  if (!out) return null;
  return path.dirname(path.isAbsolute(out) ? out : path.resolve(cwd, out));
}

/** This work tree's own root — a linked worktree's, not the main one's. */
function gitToplevel(cwd = process.cwd(), deps = {}) {
  return revParse('--show-toplevel', cwd, _toplevelCache, deps.exec);
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
  return path.resolve(gitToplevel(processCwd(), { exec }) ?? PROJECT_ROOT);
}

/** Test-only. */
export function _clearGitRootCaches() {
  _mainCheckoutRootCache.clear();
  _toplevelCache.clear();
}
