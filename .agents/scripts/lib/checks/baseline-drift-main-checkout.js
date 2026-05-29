/**
 * baseline-drift-main-checkout — refuse-and-print check.
 *
 * Detects the close-validation-main-drift failure mode where `story-close`
 * (or any close-validation step) runs against the **main checkout** while a
 * corresponding worktree exists. The active branch in the main checkout is
 * usually drifted from the Story branch by stale formatting / MI-baseline
 * commits, and the close validation then refuses to merge.
 *
 * Pre-existing epic-branch format drift blocks every story close when the
 * validator hits the main checkout.
 *
 * Surface: `story-close` preflight and the `/diagnose` CLI. Surfaced as a
 * blocker — if the validator is running against the wrong tree, none of the
 * downstream gates are reliable.
 *
 * AutoCorrect is `refuse-and-print`. The fix is for the *operator* to `cd`
 * into the worktree; an auto-fix would mutate the process's cwd, which is
 * a footgun no other check assumes.
 *
 * Detection logic:
 *   1. If headRef is not a story branch (`story-<n>`), the check does not
 *      apply — only story-close runs in this scope, and only against a
 *      story branch. Returns null.
 *   2. If a worktree at `.worktrees/<headRef>/` does NOT exist, the check
 *      cannot say anything — the operator may legitimately be running in
 *      single-tree mode. Returns null.
 *   3. If the active cwd is the worktree path, all good. Returns null.
 *   4. Otherwise the validator is running against a different tree (the
 *      main checkout) while the worktree exists. Returns a blocker with
 *      the `cd <worktree>` recipe.
 */

import path from 'node:path';
import { isStoryBranch as isFlatStoryBranch } from '../git-utils.js';

const ID = 'baseline-drift-main-checkout';

export default {
  id: ID,
  severity: 'blocker',
  scope: ['story-close', 'diagnose'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const headRef = state?.git?.headRef ?? null;
    if (!headRef || !isStoryBranch(headRef)) return null;
    const worktreePaths = state?.fs?.worktreePaths ?? [];
    if (!Array.isArray(worktreePaths) || worktreePaths.length === 0) {
      return null;
    }
    const expected = worktreePaths.find((p) => path.basename(p) === headRef);
    if (!expected) return null; // worktree for this branch doesn't exist
    const cwd = state?.cwd ?? '';
    if (samePath(cwd, expected)) return null; // already in the worktree
    return {
      id: ID,
      severity: 'blocker',
      scope: state?.scope ?? '',
      summary: `Close-validation running outside worktree (cwd: ${cwd}, expected: ${expected})`,
      detail: [
        `The active branch is ${headRef} and a worktree exists at ${expected},`,
        `but the current working directory is ${cwd}.`,
        '',
        'Close-validation must run inside the Story worktree — the main checkout',
        'may carry stale formatting or MI-baseline drift that will fail validation',
        'even when the Story branch is clean.',
      ].join('\n'),
      fixCommand: `cd "${expected}"`,
      autoCorrectable: false,
    };
  },
};

/**
 * Story branches use a flat `story-<n>` shape; the older
 * `story/epic-<id>/<n>` layout no longer applies. Accept both for forward
 * compatibility.
 *
 * @param {string} ref
 * @returns {boolean}
 */
function isStoryBranch(ref) {
  return isFlatStoryBranch(ref) || /^story\/epic-\d+\/\d+$/.test(ref);
}

/**
 * Compare two paths normalized for the platform. Windows is case-insensitive
 * and uses backslashes; POSIX is case-sensitive. We normalize both sides
 * with `path.resolve` so the comparison is stable regardless of trailing
 * separators or `./` prefixes.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}
