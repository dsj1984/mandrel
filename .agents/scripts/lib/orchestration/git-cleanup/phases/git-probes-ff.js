/**
 * Fast-forward / worktree / prune git wrappers for git-cleanup.
 *
 * @module lib/orchestration/git-cleanup/phases/git-probes-ff
 */

import { gitSpawn } from '../../../git-utils.js';

/**
 * OS file-lock signatures (mirrors `worktree/lifecycle/reap.js`). A lock-class
 * worktree removal failure defers to pending-cleanup instead of aborting the
 * ref reap.
 */
const WORKTREE_LOCK_RE =
  /(permission denied|access is denied|directory not empty|resource busy|device or resource busy|sharing violation|used by another process|EACCES|EBUSY|ENOTEMPTY)/i;

/**
 * @param {string} stderr
 * @returns {boolean}
 */
export function isWorktreeLockFailure(stderr) {
  return WORKTREE_LOCK_RE.test(stderr ?? '');
}

/* node:coverage ignore next */
export function isWorkingTreeClean(cwd) {
  return defaultFfProbes.isClean(cwd);
}

/* node:coverage ignore next */
export function fetchRef(cwd, remoteName, ref) {
  return defaultFfProbes.fetch(cwd, remoteName, ref);
}

/* node:coverage ignore next */
export function canFastForward(cwd, baseBranch, remoteName) {
  return defaultFfProbes.canFastForward(cwd, baseBranch, remoteName);
}

/* node:coverage ignore next */
export function checkoutBranch(cwd, branch) {
  return defaultFfProbes.checkout(cwd, branch);
}

/* node:coverage ignore next */
export function mergeFastForward(cwd, ref) {
  return defaultFfProbes.merge(cwd, ref);
}

/**
 * The single implementation of the FF git wrappers; callers needing an
 * injected spawn use this factory rather than a parallel copy.
 *
 * @param {(cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string }} [spawn]
 * @returns {{
 *   isClean: (cwd: string) => boolean,
 *   currentBranch: (cwd: string) => string|null,
 *   fetch: (cwd: string, remoteName: string, ref: string) => { ok: boolean, stderr?: string },
 *   canFastForward: (cwd: string, baseBranch: string, remoteName: string) => { ok: boolean, behind: number, reason?: string },
 *   checkout: (cwd: string, branch: string) => { ok: boolean, stderr?: string },
 *   merge: (cwd: string, ref: string) => { ok: boolean, stderr?: string },
 * }}
 */
export function makeFfProbes(spawn = gitSpawn) {
  return {
    isClean: (cwd) => {
      const res = spawn(cwd, 'status', '--porcelain');
      return res.status === 0 && String(res.stdout ?? '').trim() === '';
    },
    currentBranch: (cwd) => {
      const res = spawn(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD');
      return res.status !== 0 ? null : String(res.stdout ?? '').trim() || null;
    },
    fetch: (cwd, remoteName, ref) => {
      const res = spawn(cwd, 'fetch', '--quiet', remoteName, ref);
      return res.status === 0
        ? { ok: true }
        : { ok: false, stderr: res.stderr };
    },
    canFastForward: (cwd, baseBranch, remoteName) => {
      const ref = `${remoteName}/${baseBranch}`;
      const ahead = spawn(
        cwd,
        'rev-list',
        '--left-right',
        '--count',
        `${baseBranch}...${ref}`,
      );
      if (ahead.status !== 0) {
        return { ok: false, behind: 0, reason: 'rev-list-failed' };
      }
      const parts = String(ahead.stdout ?? '')
        .trim()
        .split(/\s+/);
      const localAhead = Number(parts[0]) || 0;
      const remoteAhead = Number(parts[1]) || 0;
      if (localAhead > 0) {
        return { ok: false, behind: remoteAhead, reason: 'not-fast-forward' };
      }
      return { ok: true, behind: remoteAhead };
    },
    checkout: (cwd, branch) => {
      const res = spawn(cwd, 'checkout', branch);
      return res.status === 0
        ? { ok: true }
        : { ok: false, stderr: res.stderr };
    },
    merge: (cwd, ref) => {
      const res = spawn(cwd, 'merge', '--ff-only', ref);
      return res.status === 0
        ? { ok: true }
        : { ok: false, stderr: res.stderr };
    },
  };
}

const defaultFfProbes = makeFfProbes(gitSpawn);

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

/**
 * Never `--quiet`: it suppresses the `[deleted]` lines that are the only
 * record of what was pruned, making real work read as "nothing to do".
 *
 * @param {string} cwd
 * @param {string} remoteName
 * @param {(output: string, remoteName: string) => string[]} parsePruneFn
 * @returns {{ ok: boolean, pruned: string[], stderr?: string }}
 */
/* node:coverage ignore next */
export function pruneRemoteTracking(cwd, remoteName, parsePruneFn) {
  const res = gitSpawn(cwd, 'fetch', '--prune', remoteName);
  if (res.status !== 0) return { ok: false, pruned: [], stderr: res.stderr };
  return { ok: true, pruned: parsePruneFn(res.stderr, remoteName) };
}

/* node:coverage ignore next */
export function dropStash(ref, cwd) {
  const res = gitSpawn(cwd, 'stash', 'drop', ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}
