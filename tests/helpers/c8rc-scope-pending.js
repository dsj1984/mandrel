/**
 * tests/helpers/c8rc-scope-pending.js — the files whose missing coverage row
 * the handoff is about to seat (Story #6016).
 *
 * `tests/c8rc-scope.test.js` runs inside the handoff's credited capture, one
 * step before the `seat` step writes a new file's coverage row. During that
 * step only, the scope test lets those files go without a row.
 * `delivery.handoff.postSeatChecks` re-runs it strictly after the seat.
 */

import { execFileSync } from 'node:child_process';

const PRE_SEAT_STEP = 'credited-run';

function mergeBaseDiff(baseRef, cwd) {
  return execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * The `origin/<baseBranch>` merge-base diff, the scope `--seat-missing`
 * seats. Empty outside the `credited-run` step, and on a failed diff.
 *
 * @param {{ env?: Record<string, string|undefined>, baseBranch?: string,
 *   cwd?: string, gitDiff?: (baseRef: string, cwd?: string) => string }} [opts]
 * @returns {Set<string>}
 */
export function pendingSeatFiles({
  env = process.env,
  baseBranch = 'main',
  cwd,
  gitDiff = mergeBaseDiff,
} = {}) {
  if (env.MANDREL_HANDOFF_STEP !== PRE_SEAT_STEP) return new Set();
  let out;
  try {
    out = gitDiff(`origin/${baseBranch}`, cwd);
  } catch {
    return new Set();
  }
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim().replaceAll('\\', '/'))
      .filter(Boolean),
  );
}
