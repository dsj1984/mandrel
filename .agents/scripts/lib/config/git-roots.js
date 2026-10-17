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

const canonical = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The project root a gitignored file under `root` lives in: the main
 * checkout when `root` is a work tree's own root, else `root` itself.
 */
export function storeRoot(root, exec) {
  const top = gitToplevel(root, exec);
  const isTop = top !== null && canonical(top) === canonical(root);
  return isTop ? mainCheckoutRoot(root, { exec }) : root;
}

/** Where `root`'s `.agentrc.local.json` is read: its own, else `storeRoot`'s. */
export function overlayRoot(root, exec) {
  if (fs.existsSync(path.join(root, '.agentrc.local.json'))) return root;
  return storeRoot(root, exec);
}

/** Test-only. */
export function _clearGitRootCaches() {
  _cache.clear();
}
