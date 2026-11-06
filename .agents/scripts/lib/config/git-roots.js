/** Git-derived roots; Node builtins only, since doctor imports it. */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { execFileCapture } from '../child-exec.js';
import { readJsonOrNull } from '../json-utils.js';
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
 * Where `.agentrc.json` is read: `cwd` → `AP_AGENTRC_CWD` → the nearest
 * config dir within the process cwd's work tree (else its toplevel) →
 * `PROJECT_ROOT`.
 */
export function resolveAgentrcRoot({
  cwd,
  env = process.env,
  processCwd = process.cwd,
  exec,
} = {}) {
  if (cwd) return path.resolve(cwd);
  if (env.AP_AGENTRC_CWD) return path.resolve(env.AP_AGENTRC_CWD);
  return path.resolve(cwdRoot(processCwd(), exec));
}

/** The config dir of the work tree `here` is in, or `PROJECT_ROOT`. */
function cwdRoot(here, exec) {
  const top = gitToplevel(here, exec);
  return top === null ? PROJECT_ROOT : nearestConfig(here, top);
}

/**
 * The nearest dir from `start` up to the work tree root `top` holding an
 * `.agentrc.json` — a project nested in a larger repo — else `top`.
 */
function nearestConfig(start, top) {
  const stop = canonical(top, process.platform);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.agentrc.json'))) return dir;
    const atTop = canonical(dir, process.platform) === stop;
    if (atTop || path.dirname(dir) === dir) return top;
  }
}

function nativeReal(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Native realpath (8.3 names, symlinks); win32 compares case-insensitively. */
function canonical(p, platform) {
  const win = platform === 'win32';
  const resolved = (win ? path.win32 : path).resolve(nativeReal(p));
  return win ? resolved.toLowerCase() : resolved;
}

/** The main checkout when `root` is a work tree root over a checkout's `.git`. */
function checkoutOf(root, exec, platform) {
  const top = gitToplevel(root, exec);
  const same =
    top !== null && canonical(top, platform) === canonical(root, platform);
  if (!same) return null;
  const common = revParse('--git-common-dir', root, exec) ?? '';
  return path.basename(common) === '.git'
    ? mainCheckoutRoot(root, { exec })
    : null;
}

/**
 * The project root a gitignored file under `root` lives in: the main
 * checkout for a checkout or linked worktree root, else `root` (a nested
 * project, a submodule, a separate git dir).
 */
export function storeRoot(root, exec, platform = process.platform) {
  return checkoutOf(root, exec, platform) ?? root;
}

const LOCAL_AGENTRC = '.agentrc.local.json';
const hasOverlay = (dir, fsImpl = fs) =>
  fsImpl.existsSync(path.join(dir, LOCAL_AGENTRC));

/**
 * Where `root`'s `.agentrc.local.json` is read: one overlay per machine, so a
 * linked worktree reads the main checkout's when it holds one, else its own.
 */
export function overlayRoot(root, exec, fsImpl = fs) {
  const main = storeRoot(root, exec);
  return hasOverlay(main, fsImpl) ? main : root;
}

const sameDir = (a, b) =>
  canonical(a, process.platform) === canonical(b, process.platform);

/** Equal as parsed JSON; an unparseable `own` never matches. */
function sameOverlay(own, live) {
  const parsed = readJsonOrNull(own);
  return parsed !== null && isDeepStrictEqual(parsed, readJsonOrNull(live));
}

/**
 * A linked worktree's own overlay that differs from the main checkout's one
 * in force, else `null`.
 *
 * @returns {{ worktreePath: string, mainPath: string }|null}
 */
export function overlayDivergence(root, exec) {
  const main = overlayRoot(root, exec);
  if (sameDir(main, root) || !hasOverlay(root)) return null;
  const worktreePath = path.join(root, LOCAL_AGENTRC);
  const mainPath = path.join(main, LOCAL_AGENTRC);
  return sameOverlay(worktreePath, mainPath)
    ? null
    : { worktreePath, mainPath };
}

/** Test-only. */
export function _clearGitRootCaches() {
  _cache.clear();
}
