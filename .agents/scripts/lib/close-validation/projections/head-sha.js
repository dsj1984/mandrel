// .agents/scripts/lib/close-validation/projections/head-sha.js
/**
 * head-sha.js — resolves the current working tree's HEAD commit SHA.
 *
 * Extracted from close-validation.js (Story #1850) to keep the parent
 * module below the 700-LOC target and to land the helper below CRAP 12
 * in `baselines/crap.json`. The implementation is unchanged — it shells
 * out via the injected git interface, returns `null` on any failure,
 * and never throws.
 */

import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';

/**
 * Normalise a `git rev-parse HEAD` stdout buffer to the trimmed SHA string,
 * or `null` when the output is empty. Split out of `defaultGetHeadSha` so
 * the success-path is a single straight-line statement.
 *
 * @param {string|undefined|null} stdout
 * @returns {string|null}
 */
function parseHeadSha(stdout) {
  const sha = (stdout || '').trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Resolve the current `git rev-parse HEAD` SHA inside `cwd`. Returns `null`
 * when git is unavailable or the call fails — callers treat that as
 * "evidence skip disabled" so the gate runs as before.
 *
 * @param {string} cwd
 * @param {typeof defaultGitSpawn} [gitSpawn]
 * @returns {string|null}
 */
export function defaultGetHeadSha(cwd, gitSpawn = defaultGitSpawn) {
  try {
    const res = gitSpawn(cwd, 'rev-parse', 'HEAD');
    if (res.status !== 0) return null;
    return parseHeadSha(res.stdout);
  } catch {
    return null;
  }
}
