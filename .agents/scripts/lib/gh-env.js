/**
 * The gh environment, owned by the gh boundary (`gh-exec.js`): Node builtins
 * only, so doctor and the bootstrap preflight can import it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyLocalOverlay } from './config/agentrc-overlay.js';
import { applyGhConfigDir } from './config/gh-config-dir.js';
import {
  overlayRoot,
  resolveAgentrcRoot,
  storeRoot,
} from './config/git-roots.js';

/** Applied dir (or null) per anchor root. */
const _ensuredByRoot = new Map();

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
 * store lives. Memoised per anchor root unless deps are injected.
 *
 * @returns {string|null} the applied dir.
 */
export function ensureGhEnv(deps = {}) {
  const { cwd, env = process.env, fsImpl = fs, exec } = deps;
  const memoize = env === process.env && fsImpl === fs && !exec;
  const root = resolveAgentrcRoot({ cwd, env, exec });
  if (memoize && _ensuredByRoot.has(root)) return _ensuredByRoot.get(root);
  const { effective } = applyLocalOverlay({
    fsImpl,
    projectRoot: overlayRoot(root, exec),
    committed: readCommittedAgentrc(fsImpl, root),
  });
  const dir = applyGhConfigDir(effective?.github, storeRoot(root, exec), {
    env,
    fsImpl,
  });
  if (memoize) _ensuredByRoot.set(root, dir);
  return dir;
}

/** `base` with the ensured `GH_CONFIG_DIR` layered on; throws a config error. */
export function ghEnv(base = process.env) {
  const dir = ensureGhEnv();
  return dir ? { ...base, GH_CONFIG_DIR: dir } : base;
}

/**
 * `{ env }` — `base` with the ensured `GH_CONFIG_DIR` — or, on a config
 * error, `{ failure }`: a failed `spawnSync`-shaped result carrying it.
 */
export function tryGhEnv(base = process.env) {
  try {
    return { env: ghEnv(base) };
  } catch (error) {
    return {
      failure: { status: null, stdout: '', stderr: error.message, error },
    };
  }
}
