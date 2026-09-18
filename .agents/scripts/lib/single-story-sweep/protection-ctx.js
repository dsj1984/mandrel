/**
 * single-story-sweep/protection-ctx.js
 *
 * The one builder of the `evaluateProtection` ctx for every sweep caller.
 * `ghRunner` stays on synchronous `spawnSync` (not the async gh-exec facade)
 * because the checks run inside a synchronous candidate-filter loop.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { gitSpawn } from '../git-utils.js';

/**
 * @param {string} cwd Repo root used as the default spawn cwd.
 * @param {typeof defaultSpawnSync} [spawnImpl]
 * @returns {(args: string[], opts?: { cwd?: string }) => string}
 */
export function makeGhRunner(cwd, spawnImpl = defaultSpawnSync) {
  return (args, opts) => {
    const result = spawnImpl('gh', args, {
      cwd: opts?.cwd ?? cwd,
      encoding: 'utf-8',
      shell: false,
    });
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
 *   spawnImpl?: typeof defaultSpawnSync,
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
