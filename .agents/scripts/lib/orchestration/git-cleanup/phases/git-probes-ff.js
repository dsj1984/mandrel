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
 * Build the fast-forward probe bundle bound to a `gitSpawn`.
 *
 * This is the **single implementation** of the FF/base-sync git wrappers.
 * The standalone exports above delegate to a default instance bound to the
 * shared `gitSpawn`; callers that need to inject their own spawn for testing
 * (e.g. the epic-cleanup runner) call this factory directly instead of
 * hand-rolling a parallel copy (framework-gap #4379). The bundle also carries
 * `currentBranch` so an injecting caller gets the whole FF surface from one
 * place.
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

// Default instance bound to the shared gitSpawn; the standalone wrappers
// above delegate to it so there is exactly one FF-probe implementation.
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
