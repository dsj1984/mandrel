/**
 * git-branch-cleanup.js — Shared branch deletion helpers (local + remote).
 *
 * Consolidates the "delete this branch from local and/or origin" pattern
 * used by `single-story-close.js` and other branch-reaping flows. Originally
 * carved out when more than one caller re-implemented the same idempotency
 * rules with subtle drift.
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
export function deleteBranchEverywhere(name, opts = {}) {
  const local = deleteBranchLocal(name, opts);
  const remote = deleteBranchRemote(name, opts);
  const bothOk = local.deleted && remote.deleted;
  let reason;
  if (bothOk) reason = 'deleted';
  else if (local.deleted || remote.deleted) reason = 'partial';
  else reason = 'error';
  return { deleted: bothOk, reason, local, remote };
}

/**
 * Delete N branches in a single batched git call (push --delete X Y Z, or
 * branch -D X Y Z), falling back to per-ref delete via
 * `deleteBranchLocal` / `deleteBranchRemote` if the batched call fails.
 * The fallback is what makes idempotency contract-correct: a batched call
 * fails as a unit if even one ref does not exist, but the per-ref retry
 * resolves each ref's outcome independently — `not-found` is reported as
 * deleted, real failures are surfaced.
 *
 * @param {string[]} names - Branch names. Empty / falsy entries are
 *   filtered out before any git work.
 * @param {{ scope: 'local'|'remote', cwd?: string, force?: boolean, remote?: string, noVerify?: boolean }} opts
 *   - `scope`: required. `'local'` runs `git branch -D|-d`; `'remote'`
 *     runs `git push <remote> --delete`.
 *   - `force`, `remote`, `noVerify`: forwarded to the per-ref helper on
 *     the fallback path; `force` and `noVerify` are also honoured on the
 *     batched call.
 * @returns {{ deleted: string[], failed: Array<{ name: string, reason: string, stderr?: string }> }}
 *   `deleted` lists names that were successfully deleted (or were
 *   already gone). `failed` lists names whose per-ref retry returned a
 *   non-deleted result, with the lib's `reason` propagated.
 */
function assertBatchedScope(scope) {
  if (scope !== 'local' && scope !== 'remote') {
    throw new Error(
      `deleteBranchesBatched: scope must be "local" or "remote", got "${scope}".`,
    );
  }
}

function runBatchedLocalDelete(list, cwd, opts) {
  const flag = opts.force === false ? '-d' : '-D';
  return gitSpawn(cwd, 'branch', flag, ...list);
}

function runBatchedRemoteDelete(list, cwd, opts) {
  const remote = opts.remote ?? 'origin';
  if (!isSafeBranchName(remote)) {
    throw new Error(`[git-branch-cleanup] Unsafe remote name: "${remote}".`);
  }
  const args = ['push'];
  if (opts.noVerify) args.push('--no-verify');
  args.push(remote, '--delete', ...list);
  return gitSpawn(cwd, ...args);
}

function perRefFallback(list, scope, opts) {
  const deleted = [];
  const failed = [];
  for (const n of list) {
    const r =
      scope === 'local'
        ? deleteBranchLocal(n, opts)
        : deleteBranchRemote(n, opts);
    if (r.deleted) deleted.push(n);
    else failed.push({ name: n, reason: r.reason, stderr: r.stderr });
  }
  return { deleted, failed };
}

export function deleteBranchesBatched(names, opts = {}) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean);
  if (list.length === 0) return { deleted: [], failed: [] };

  const scope = opts.scope;
  assertBatchedScope(scope);
  // Validate every name before any destructive call so a single bad
  // entry can never leak into a batched git invocation.
  for (const n of list) assertBranchSafe(n, { protected: true });

  const cwd = opts.cwd ?? process.cwd();
  const batchedRes =
    scope === 'local'
      ? runBatchedLocalDelete(list, cwd, opts)
      : runBatchedRemoteDelete(list, cwd, opts);

  if (batchedRes.status === 0) {
    return { deleted: [...list], failed: [] };
  }

  // Per-ref fallback. Each call independently classifies its outcome —
  // already-gone refs are reported as `not-found` (counted as deleted),
  // real failures surface in `failed[]`.
  return perRefFallback(list, scope, opts);
}
