/**
 * single-story-sweep/protection-ctx.js
 *
 * The one builder of the `evaluateProtection` ctx for every sweep caller.
 * `ghRunner` stays synchronous (gh-exec's `runGh`, not the async `exec()`
 * facade) because the checks run inside a synchronous candidate-filter loop.
 */

import { runGh } from '../gh-exec.js';
import { gitSpawn } from '../git-utils.js';

/**
 * @param {string} cwd Repo root used as the default spawn cwd.
 * @param {Function} [spawnImpl] - `spawnSync`-shaped; defaults to `spawnSync`.
 * @returns {(args: string[], opts?: { cwd?: string }) => string}
 */
export function makeGhRunner(cwd, spawnImpl) {
  return (args, opts) => {
    const result = runGh(
      args,
      { cwd: opts?.cwd ?? cwd, encoding: 'utf-8', shell: false },
      spawnImpl,
    );
    if (result.status !== 0) {
      throw new Error(
        `gh ${args.join(' ')} exit ${result.status}: ${result.stderr ?? ''}`,
      );
    }
    return result.stdout ?? '';
  };
}

/**
 * @param {{
 *   cwd: string,
 *   provider: { getTicket: (id: number) => Promise<object> },
 *   spawnImpl?: Function,
 * }} args
 * @returns {{
 *   repoRoot: string,
 *   gitSpawn: typeof gitSpawn,
 *   ghRunner: (args: string[], opts?: { cwd?: string }) => string,
 *   getTicket: (id: number) => Promise<object>,
 * }}
 */
export function buildProtectionCtx({ cwd, provider, spawnImpl }) {
  return {
    repoRoot: cwd,
    gitSpawn,
    ghRunner: makeGhRunner(cwd, spawnImpl),
    getTicket: (id) => provider.getTicket(id),
  };
}
