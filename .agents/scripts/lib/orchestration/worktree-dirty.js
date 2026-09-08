/**
 * lib/orchestration/worktree-dirty.js — "does this branch's checkout carry
 * uncommitted changes?" (Story #5238).
 *
 * Its own module because the light path's diff backstop is otherwise a pure
 * join over two committed-state git reads, and this is the one question there
 * that needs a third read of a *working tree*. Keeping it here leaves
 * {@link module:lib/orchestration/light-backstop} the thin join it claims to
 * be, and gives the probe its own place to be tested against every way a git
 * read can fail.
 *
 * @module lib/orchestration/worktree-dirty
 */

import { gitSpawn } from '../git-utils.js';
import { parseWorktreePorcelain } from '../worktree/inspector.js';

/**
 * The stdout of a successful git read, or `null` when it cannot be trusted.
 *
 * @param {{ status?: number, stdout?: unknown }|null|undefined} result
 * @returns {string|null}
 */
function readableStdout(result) {
  if (result?.status !== 0) return null;
  return typeof result.stdout === 'string' ? result.stdout : null;
}

/**
 * Locate the checkout that has `branch` checked out, or `null` when no
 * checkout does.
 *
 * `git worktree list --porcelain` enumerates **every** checkout including the
 * main one, so a repository working on the branch directly (no separate
 * worktree) is found by this same lookup rather than by a second fallback path.
 *
 * @param {{ branch: string, cwd: string, gitFn: typeof gitSpawn }} args
 * @returns {string|null}
 */
function resolveBranchCheckout({ branch, cwd, gitFn }) {
  const listed = readableStdout(gitFn(cwd, 'worktree', 'list', '--porcelain'));
  if (listed === null) return null;
  const match = parseWorktreePorcelain(listed).find(
    (record) => record.branch === branch,
  );
  return match ? match.path : null;
}

/**
 * Does the checkout holding `branch` have uncommitted changes?
 *
 * **Why the light path asks.** Its diff backstop measures `base...head`, which
 * is committed state, so a run that implemented and did not commit measures an
 * empty change set — and the refusal then told the agent its scope was
 * unverifiable and to escalate, when the actual fix was `git commit`. Measured
 * in the consumer: the refusal signal is stamped 12:14:06Z and the branch's
 * only commit 12:15:19Z (issue #5237).
 *
 * Total, and deliberately asymmetric: every unreadable surface — a failed
 * `worktree list`, a branch no checkout holds, a failed `status`, a throwing
 * git — answers `false`. A probe that cannot see the tree must not be able to
 * talk a refusal into friendlier guidance than the evidence supports.
 *
 * @param {{ branch: string, cwd?: string, gitFn?: typeof gitSpawn }} args
 * @returns {boolean}
 */
export function hasUncommittedWork({
  branch,
  cwd = process.cwd(),
  gitFn = gitSpawn,
} = {}) {
  try {
    const checkout = resolveBranchCheckout({ branch, cwd, gitFn });
    if (checkout === null) return false;
    const status = readableStdout(gitFn(checkout, 'status', '--porcelain'));
    return status !== null && status.trim() !== '';
  } catch {
    return false;
  }
}
