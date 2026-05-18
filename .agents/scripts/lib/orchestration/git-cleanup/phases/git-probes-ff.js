/**
 * git-probes-ff.js — fast-forward / worktree / prune subprocess wrappers
 * for git-cleanup (Story #2466).
 *
 * Split out of `git-probes.js` so each phase file stays under Story
 * #2466's 200-LOC ceiling. Owns the wrappers the fast-forward-main,
 * prune-remotes, and worktree-reap paths call.
 *
 * @module lib/orchestration/git-cleanup/phases/git-probes-ff
 */

import { gitSpawn } from '../../../git-utils.js';

/* node:coverage ignore next */
export function isWorkingTreeClean(cwd) {
  const res = gitSpawn(cwd, 'status', '--porcelain');
  if (res.status !== 0) return false;
  return res.stdout.trim() === '';
}

/* node:coverage ignore next */
export function fetchRef(cwd, remoteName, ref) {
  const res = gitSpawn(cwd, 'fetch', '--quiet', remoteName, ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/* node:coverage ignore next */
export function canFastForward(cwd, baseBranch, remoteName) {
  const ref = `${remoteName}/${baseBranch}`;
  const ahead = gitSpawn(
    cwd,
    'rev-list',
    '--left-right',
    '--count',
    `${baseBranch}...${ref}`,
  );
  if (ahead.status !== 0) {
    return { ok: false, behind: 0, reason: 'rev-list-failed' };
  }
  const parts = ahead.stdout.trim().split(/\s+/);
  const localAhead = Number(parts[0]) || 0;
  const remoteAhead = Number(parts[1]) || 0;
  if (localAhead > 0) {
    return { ok: false, behind: remoteAhead, reason: 'not-fast-forward' };
  }
  return { ok: true, behind: remoteAhead };
}

/* node:coverage ignore next */
export function checkoutBranch(cwd, branch) {
  const res = gitSpawn(cwd, 'checkout', branch);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/* node:coverage ignore next */
export function mergeFastForward(cwd, ref) {
  const res = gitSpawn(cwd, 'merge', '--ff-only', ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/* node:coverage ignore next */
export function removeWorktree(worktreePath, cwd) {
  const plain = gitSpawn(cwd, 'worktree', 'remove', worktreePath);
  if (plain.status === 0) return { ok: true, dirty: false };
  const forced = gitSpawn(cwd, 'worktree', 'remove', '--force', worktreePath);
  if (forced.status === 0) {
    return { ok: true, dirty: true, stderr: plain.stderr };
  }
  return { ok: false, dirty: true, stderr: forced.stderr || plain.stderr };
}

/* node:coverage ignore next */
export function pruneRemoteTracking(cwd, remoteName, parsePruneFn) {
  const res = gitSpawn(cwd, 'fetch', '--prune', '--quiet', remoteName);
  if (res.status !== 0) return { ok: false, pruned: [], stderr: res.stderr };
  return { ok: true, pruned: parsePruneFn(res.stderr, remoteName) };
}

/* node:coverage ignore next */
export function dropStash(ref, cwd) {
  const res = gitSpawn(cwd, 'stash', 'drop', ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}
