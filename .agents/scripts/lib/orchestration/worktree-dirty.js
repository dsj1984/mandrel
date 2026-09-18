/**
 * Does a branch's checkout carry uncommitted changes?
 *
 * @module lib/orchestration/worktree-dirty
 */

import { gitSpawn } from '../git-utils.js';
import { parseWorktreePorcelain } from '../worktree/inspector.js';

/**
 * @param {{ status?: number, stdout?: unknown }|null|undefined} result
 * @returns {string|null}
 */
function readableStdout(result) {
  if (result?.status !== 0) return null;
  return typeof result.stdout === 'string' ? result.stdout : null;
}

/**
 * `worktree list` includes the main checkout, so no second fallback is needed.
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
 * The light backstop diffs committed state, so uncommitted work reads as an
 * empty change set; this lets the refusal say "commit" instead. Every
 * unreadable surface answers `false` — a blind probe must not soften a refusal.
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
