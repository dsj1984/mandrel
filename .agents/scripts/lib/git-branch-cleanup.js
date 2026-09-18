/**
 * git-branch-cleanup.js — local/remote branch deletion. Names pass the
 * protected `assertBranchSafe` guard (no `main`/`master`/`HEAD`/`refs/*`)
 * before any destructive call; "not found" counts as deleted (idempotent);
 * git's normal failures are returned, never thrown.
 */

import { assertBranchSafe, isSafeBranchName } from './branch-name-guard.js';
import { gitSpawn } from './git-utils.js';

const NOT_FOUND_LOCAL = /not found|no such branch|did not match any/i;
const NOT_FOUND_REMOTE = /remote ref does not exist|does not exist/i;

/**
 * @param {string} name
 * @param {{ force?: boolean, cwd?: string }} [opts] `force` (default) = `-D`.
 * @returns {{ deleted: boolean, reason: string, stderr?: string }}
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
 * @param {string} name
 * @param {{ remote?: string, cwd?: string, noVerify?: boolean }} [opts]
 *   `noVerify` skips a heavy `pre-push` hook on a delete-only push.
 * @returns {{ deleted: boolean, reason: string, stderr?: string }}
 */
export function deleteBranchRemote(name, opts = {}) {
  assertBranchSafe(name, { protected: true });
  const remote = opts.remote ?? 'origin';
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
 * Always attempts both sides — a local failure does not skip the remote.
 *
 * @param {string} name
 * @param {{ force?: boolean, remote?: string, cwd?: string, noVerify?: boolean }} [opts]
 * @returns {{
 *   deleted: boolean,
 *   reason: string,
 *   local: ReturnType<typeof deleteBranchLocal>,
 *   remote: ReturnType<typeof deleteBranchRemote>,
 * }}
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
 * Delete N branches in one git call, falling back to per-ref deletes when it
 * fails — a batch fails as a unit on one missing ref, so the fallback is what
 * keeps not-found idempotent.
 *
 * @param {string[]} names - Branch names; falsy entries are dropped.
 * @param {{ scope: 'local'|'remote', cwd?: string, force?: boolean, remote?: string, noVerify?: boolean }} opts
 * @returns {{ deleted: string[], failed: Array<{ name: string, reason: string, stderr?: string }> }}
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
  // Validate all names first so a bad entry never reaches a batched call.
  for (const n of list) assertBranchSafe(n, { protected: true });

  const cwd = opts.cwd ?? process.cwd();
  const batchedRes =
    scope === 'local'
      ? runBatchedLocalDelete(list, cwd, opts)
      : runBatchedRemoteDelete(list, cwd, opts);

  if (batchedRes.status === 0) {
    return { deleted: [...list], failed: [] };
  }

  return perRefFallback(list, scope, opts);
}
