/**
 * single-story-sweep/protection-ctx.js
 *
 * Shared builder for the `evaluateProtection` context the boot-sweep
 * engine ([`sweepMergedBranches`](../single-story-sweep.js)) threads into
 * every candidate protection check. Single-homed here so the three boot
 * callers — `single-story-init.js` and the
 * `boot-sweep.js` CLI — build an identical ctx instead of each re-wiring
 * the git/gh/ticket ports.
 *
 * Story #2990: the sweep protection-ctx `ghRunner` stays on raw
 * `spawnSync('gh', …)` (not the `lib/gh-exec.js` async facade) because
 * `executeCleanup` invokes the protection checks inside a synchronous
 * candidate-filter loop. The runner contract is the legacy
 * `(args, opts) => stdout string` shape.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { gitSpawn } from '../git-utils.js';

/**
 * Build the synchronous `gh` runner the sweep uses for its
 * candidate-protection checks.
 *
 * Story #4073: the `spawnImpl` seam injects the `spawnSync` boundary so
 * the runner's success/error handling can be unit-tested without a live
 * `gh` binary. It defaults to `child_process.spawnSync`, so the
 * production CLI path is unchanged.
 *
 * @param {string} cwd Repo root used as the default spawn cwd.
 * @param {typeof defaultSpawnSync} [spawnImpl] Injectable spawn boundary —
 *   defaults to `child_process.spawnSync`.
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
 * Build the `evaluateProtection` ctx bag: the repo root, the `gitSpawn`
 * port, the synchronous `gh` runner, and a `getTicket` port bound to the
 * supplied provider.
 *
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
