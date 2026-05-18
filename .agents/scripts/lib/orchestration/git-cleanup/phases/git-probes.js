/**
 * git-probes.js — branch / worktree / PR probe wrappers for git-cleanup
 * (Story #2466).
 *
 * Owns the wrappers the branches-phase planner calls to enumerate local
 * + remote branches, walk worktrees, and probe `gh pr list` for merged
 * PRs. Fast-forward / cleanup probes live in `git-probes-ff.js`.
 *
 * Re-exports the FF probes so consumers that previously imported the
 * unified surface (`isWorkingTreeClean`, etc) keep working without
 * touching their import paths.
 *
 * @module lib/orchestration/git-cleanup/phases/git-probes
 */

import { execFileSync } from 'node:child_process';

import { gitSpawn } from '../../../git-utils.js';
import { parseWorktreePorcelain } from '../../../worktree-manager.js';

export {
  canFastForward,
  checkoutBranch,
  dropStash,
  fetchRef,
  isWorkingTreeClean,
  mergeFastForward,
  pruneRemoteTracking,
  removeWorktree,
} from './git-probes-ff.js';

/* node:coverage ignore next */
export function listLocalBranches(cwd) {
  const res = gitSpawn(
    cwd,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/',
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/* node:coverage ignore next */
export function listRemoteBranches(cwd, remoteName = 'origin') {
  const res = gitSpawn(
    cwd,
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/remotes/${remoteName}/`,
  );
  if (res.status !== 0) return [];
  const prefix = `${remoteName}/`;
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l))
    .filter((b) => b && b !== 'HEAD');
}

/* node:coverage ignore next */
export function listMergedBranches(cwd, base) {
  const res = gitSpawn(
    cwd,
    'branch',
    '--merged',
    base,
    '--format=%(refname:short)',
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/* node:coverage ignore next */
export function currentBranch(cwd) {
  const res = gitSpawn(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/* node:coverage ignore next */
export function readProtectedConfig(cwd) {
  const res = gitSpawn(cwd, 'config', '--get', 'branch.protectedBranches');
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* node:coverage ignore next */
export function worktreesByBranch(cwd) {
  const res = gitSpawn(cwd, 'worktree', 'list', '--porcelain');
  if (res.status !== 0) return new Map();
  const records = parseWorktreePorcelain(res.stdout);
  const map = new Map();
  for (const r of records) {
    if (r.branch && r.path)
      map.set(r.branch, { path: r.path, branch: r.branch });
  }
  return map;
}

/* node:coverage ignore next */
export function defaultGhRunner(args, { cwd }) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8' });
}

/**
 * Check whether a branch has a merged PR via `gh`.
 */
export function probeMergedPr(branch, cwd, runGh = defaultGhRunner) {
  const out = runGh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'merged',
      '--json',
      'number,mergedAt',
      '--limit',
      '1',
    ],
    { cwd },
  );
  const trimmed = (out ?? '').trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const row = parsed[0];
  return {
    number: Number(row.number) || 0,
    mergedAt: row.mergedAt ?? null,
  };
}
