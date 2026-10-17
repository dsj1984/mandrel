/**
 * The gh environment, owned by the gh boundary (`gh-exec.js`): Node builtins
 * only, so doctor and the bootstrap preflight can import it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyLocalOverlay } from './config/agentrc-overlay.js';
import { applyGhConfigDir } from './config/gh-config-dir.js';
import { mainCheckoutRoot, resolveAgentrcRoot } from './config/git-roots.js';

/** `undefined` until the first ensure. */
let _ensuredGhConfigDir;

function readCommittedAgentrc(fsImpl, root) {
  try {
    return JSON.parse(
      fsImpl.readFileSync(path.join(root, '.agentrc.json'), 'utf8'),
    );
  } catch {
    return {};
  }
}

/**
 * Export `GH_CONFIG_DIR` from `github.cliConfigDir` before any `gh` spawn. A
 * relative dir resolves against the main checkout, where the gitignored
 * store lives. Memoised per process unless deps are injected.
 *
 * @returns {string|null} the applied dir.
 */
export function ensureGhEnv(deps = {}) {
  const { cwd, env = process.env, fsImpl = fs, exec, homedir, warn } = deps;
  const memoize = env === process.env && fsImpl === fs && !exec;
  if (memoize && _ensuredGhConfigDir !== undefined) return _ensuredGhConfigDir;
  const root = resolveAgentrcRoot({ cwd, env, exec });
  const { effective } = applyLocalOverlay({
    fsImpl,
    projectRoot: root,
    committed: readCommittedAgentrc(fsImpl, root),
  });
  const storeRoot = mainCheckoutRoot(root, { exec }) ?? root;
  const dir = applyGhConfigDir(effective?.github, storeRoot, {
    env,
    fsImpl,
    homedir,
    warn,
  });
  if (memoize) _ensuredGhConfigDir = dir;
  return dir;
}

/** Test-only. */
export function _resetGhEnvForTests() {
  _ensuredGhConfigDir = undefined;
}

/** `base` with the ensured `GH_CONFIG_DIR` layered on. */
export function ghEnv(base = process.env) {
  const dir = ensureGhEnv();
  return dir ? { ...base, GH_CONFIG_DIR: dir } : base;
}
