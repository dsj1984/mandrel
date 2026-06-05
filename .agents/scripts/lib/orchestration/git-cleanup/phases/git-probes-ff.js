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

/**
 * Windows file-lock-class failure signatures. Mirrors the regex in
 * `worktree/lifecycle/reap.js` — a `git worktree remove` that fails with
 * one of these is an OS-level lock on the worktree directory (open
 * `node_modules` handles, AV/indexer, test/coverage artifacts), not a
 * git-state problem. Lock-class removal failures degrade to a deferred
 * `pending-cleanup` handoff instead of aborting the candidate's ref reap.
 */
const WORKTREE_LOCK_RE =
  /(permission denied|access is denied|directory not empty|resource busy|device or resource busy|sharing violation|used by another process|EACCES|EBUSY|ENOTEMPTY)/i;

/**
 * Classify a worktree-removal stderr as Windows-lock-class or not.
 *
 * @param {string} stderr
 * @returns {boolean} `true` when the failure looks like an OS file lock.
 */
export function isWorktreeLockFailure(stderr) {
  return WORKTREE_LOCK_RE.test(stderr ?? '');
}

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
  const stderr = forced.stderr || plain.stderr;
  return {
    ok: false,
    dirty: true,
    lockClass: isWorktreeLockFailure(stderr),
    stderr,
  };
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
