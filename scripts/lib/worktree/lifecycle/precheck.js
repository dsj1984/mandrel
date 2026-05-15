/**
 * worktree/lifecycle/precheck.js
 *
 * The "is the tree itself shaped for removal?" half of `isSafeToRemove`.
 * Owns the defensive guard cascade — missing path, dirty index, detached
 * HEAD, rev-parse failure — and returns `{ safe, reason, branch? }`. The
 * companion module `merge-reachability.js` answers the "is the work
 * integrated upstream?" half once this module has produced a clean
 * working-branch name.
 *
 * Pure with respect to the supplied `ctx` bag; the only side effects are
 * the `gitSpawn` calls. No callers other than `isSafeToRemove` should
 * import this directly — the split exists purely to keep the parent's
 * cyclomatic budget under the CRAP gate while leaving each phase
 * independently testable.
 */

import fs from 'node:fs';

/**
 * @typedef {object} PrecheckResult
 * @property {boolean} safe
 *   `true` when the tree's local state permits removal *so far*; the
 *   caller still has to clear the merge-reachability gate before
 *   reporting overall safety.
 * @property {string} [reason]
 *   Populated on every non-trivial outcome (including `safe: true` when
 *   the path is missing, so the caller can short-circuit the rest of the
 *   pipeline).
 * @property {string} [branch]
 *   Only set on `safe: true` from a normal (not path-missing) check —
 *   carries the worktree's current branch name so the reachability gate
 *   can grep the Epic log for the matching merge commit.
 */

/**
 * Run every local-state guard against `wtPath` and return a structured
 * verdict. `path-missing` is reported as `safe: true` because nothing on
 * disk needs cleanup; the caller will short-circuit and skip the merge
 * gate. Every other failure mode is reported as `safe: false` with a
 * machine-readable `reason`.
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @returns {PrecheckResult}
 */
export function checkLocalSafety(ctx, wtPath) {
  if (!fs.existsSync(wtPath)) {
    return { safe: true, reason: 'path-missing' };
  }
  const dirty = checkWorktreeDirty(ctx, wtPath);
  if (!dirty.safe) return dirty;
  const branchCheck = readWorkingBranch(ctx, wtPath);
  if (!branchCheck.safe) return branchCheck;
  return { safe: true, branch: branchCheck.branch };
}

/**
 * Predicate: does `git status --porcelain` come back clean? Returns
 * `{ safe: true }` when the worktree has no uncommitted edits, or
 * `{ safe: false, reason }` for either a status-command failure or a
 * non-empty status output.
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @returns {{safe: boolean, reason?: string}}
 */
export function checkWorktreeDirty(ctx, wtPath) {
  const status = ctx.git.gitSpawn(wtPath, 'status', '--porcelain');
  if (status.status !== 0) {
    return { safe: false, reason: `status-failed: ${status.stderr}` };
  }
  if (status.stdout.length > 0) {
    return { safe: false, reason: 'uncommitted-changes' };
  }
  return { safe: true };
}

/**
 * Predicate: read the worktree's current branch via
 * `git rev-parse --abbrev-ref HEAD`. Returns the branch name on success,
 * or a `{ safe: false, reason }` envelope when the command fails or HEAD
 * is detached. The detached-HEAD case is treated as unsafe because the
 * branch identity is the lookup key the reachability gate needs.
 *
 * @param {object} ctx
 * @param {string} wtPath
 * @returns {{safe: boolean, reason?: string, branch?: string}}
 */
export function readWorkingBranch(ctx, wtPath) {
  const headRes = ctx.git.gitSpawn(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (headRes.status !== 0) {
    return { safe: false, reason: `rev-parse-failed: ${headRes.stderr}` };
  }
  const branch = headRes.stdout;
  if (branch === 'HEAD') {
    return { safe: false, reason: 'detached-head' };
  }
  return { safe: true, branch };
}
