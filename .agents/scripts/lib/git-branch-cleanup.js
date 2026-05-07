/**
 * git-branch-cleanup.js — Shared branch deletion helpers (local + remote).
 *
 * Consolidates the "delete this branch from local and/or origin" pattern
 * that `delete-epic-branches.js`, `epic-close.js`, and
 * `story-close.js` had each re-implemented with subtly different
 * idempotency rules.
 *
 * All helpers:
 *   - Take an explicit `cwd` (worktree-isolation friendly).
 *   - Validate branch names via the canonical `assertBranchSafe` guard
 *     in protected mode (rejects `main`, `master`, `HEAD`, and `refs/*`
 *     before any destructive `git` invocation).
 *   - Treat "branch not found" / "remote ref does not exist" as success
 *     (idempotent), distinguishing it via `reason: 'not-found'`.
 *   - Return `{ deleted: bool, reason: string, stderr?: string }` and
 *     never throw on git's normal failure modes (caller inspects the result).
 *
 * Migration is out of scope for this task — call sites migrate in a
 * follow-up Story.
 */

import { assertBranchSafe, isSafeBranchName } from './branch-name-guard.js';
import { gitSpawn } from './git-utils.js';

const NOT_FOUND_LOCAL = /not found|no such branch|did not match any/i;
const NOT_FOUND_REMOTE = /remote ref does not exist|does not exist/i;

/**
 * Delete a local branch.
 *
 * @param {string} name - Branch name.
 * @param {{ force?: boolean, cwd?: string }} [opts]
 *   - `force`: use `branch -D` (default true). When false, uses `branch -d`,
 *     which refuses to delete unmerged branches.
 *   - `cwd`: working directory (defaults to `process.cwd()`).
 * @returns {{ deleted: boolean, reason: string, stderr?: string }}
 *   `reason` is one of: `'deleted'`, `'not-found'`, `'unmerged'`, `'error'`.
 */
export function deleteBranchLocal(name, opts = {}) {
  assertBranchSafe(name, { protected: true });
  const force = opts.force !== false;
  const cwd = opts.cwd ?? process.cwd();
  const flag = force ? '-D' : '-d';

  const res = gitSpawn(cwd, 'branch', flag, name);
  if (res.status === 0) {
    return { deleted: true, reason: 'deleted' };
  }
  const stderr = res.stderr ?? '';
  if (NOT_FOUND_LOCAL.test(stderr)) {
    return { deleted: true, reason: 'not-found' };
  }
  if (!force && /not fully merged/i.test(stderr)) {
    return { deleted: false, reason: 'unmerged', stderr };
  }
  return { deleted: false, reason: 'error', stderr };
}

/**
 * Delete a branch on the remote.
 *
 * @param {string} name - Branch name (no `refs/heads/` prefix).
 * @param {{ remote?: string, cwd?: string, noVerify?: boolean }} [opts]
 *   - `noVerify`: pass `--no-verify` so a heavy `pre-push` hook does not
 *     block a delete-only push (the hook would still fire even though no
 *     commits are being uploaded). Default `false`.
 * @returns {{ deleted: boolean, reason: string, stderr?: string }}
 *   `reason` is one of: `'deleted'`, `'not-found'`, `'error'`.
 */
export function deleteBranchRemote(name, opts = {}) {
  assertBranchSafe(name, { protected: true });
  const remote = opts.remote ?? 'origin';
  // Remote name (e.g. "origin") is a non-branch identifier; reuse the
  // shared character-set predicate but raise a remote-scoped error so
  // the failure message stays accurate.
  if (!isSafeBranchName(remote)) {
    throw new Error(`[git-branch-cleanup] Unsafe remote name: "${remote}".`);
  }
  const cwd = opts.cwd ?? process.cwd();
  const args = ['push'];
  if (opts.noVerify) args.push('--no-verify');
  args.push(remote, '--delete', name);

  const res = gitSpawn(cwd, ...args);
  if (res.status === 0) {
    return { deleted: true, reason: 'deleted' };
  }
  const stderr = res.stderr ?? '';
  if (NOT_FOUND_REMOTE.test(stderr)) {
    return { deleted: true, reason: 'not-found' };
  }
  return { deleted: false, reason: 'error', stderr };
}

/**
 * Delete a branch in both locations. Always attempts both — a local
 * failure does not skip the remote attempt.
 *
 * @param {string} name
 * @param {{ force?: boolean, remote?: string, cwd?: string, noVerify?: boolean }} [opts]
 * @returns {{
 *   deleted: boolean,
 *   reason: string,
 *   local: ReturnType<typeof deleteBranchLocal>,
 *   remote: ReturnType<typeof deleteBranchRemote>,
 * }}
 *   Top-level `deleted` is true iff both sides succeeded (including
 *   idempotent not-found). `reason` is `'deleted'`, `'partial'`, or
 *   `'error'`.
 */
export function deleteBranchBoth(name, opts = {}) {
  const local = deleteBranchLocal(name, opts);
  const remote = deleteBranchRemote(name, opts);
  const bothOk = local.deleted && remote.deleted;
  let reason;
  if (bothOk) reason = 'deleted';
  else if (local.deleted || remote.deleted) reason = 'partial';
  else reason = 'error';
  return { deleted: bothOk, reason, local, remote };
}
