// .agents/scripts/lib/close-validation/projections/head-sha.js
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';

/**
 * @param {string|undefined|null} stdout
 * @returns {string|null}
 */
function parseHeadSha(stdout) {
  const sha = (stdout || '').trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Never throws; `null` disables the evidence skip so the gate runs.
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
