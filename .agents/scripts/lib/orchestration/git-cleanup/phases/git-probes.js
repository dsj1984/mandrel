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
// Story #2990: this `gh` probe stays on synchronous `execFileSync` (not
// the `lib/gh-exec.js` async facade) because `planCleanup` is a
// synchronous planner and `prProbe` is invoked inside a sync `for`
// loop. Converting the planner to async would ripple into every
// `git-cleanup` caller and is out of scope for the callers-only
// provider migration.
export function defaultGhRunner(args, { cwd }) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8' });
}

/**
 * Check whether a branch has a merged PR via `gh`.
 *
 * Legacy probe: queries `--state merged` and returns the first merged row's
 * `{ number, mergedAt }`. Kept exported so older call sites and tests that
 * predate the latest-PR-state model continue to work — the planner now
 * defaults to {@link probeLatestPr} for the bug-A correctness fix, but a
 * caller can still inject this as `prProbe` to opt into the historical
 * "any merge on this head" semantics.
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

/**
 * Probe the most-recent PR on a branch head ref, regardless of state.
 *
 * Replaces {@link probeMergedPr} as the planner's default merge signal so
 * branches with reused names (release-please, dependabot, renovate, manual
 * reuse) cannot be silently reaped on a stale historical merge. The right
 * question is "is the *latest* PR on this head ref a merge?" — not "did
 * *any* PR ever merge on this head ref?". Returning the full state lets
 * the planner skip OPEN and CLOSED-not-merged refs with operator-visible
 * reasons.
 *
 * `headRefOid` is included so the planner can cross-check the current
 * branch tip against the commit the PR actually merged (or pointed at);
 * post-merge force-pushes flip the tip out from under a historical merge
 * signal and would otherwise still reap.
 *
 * @param {string} branch
 * @param {string} cwd
 * @param {(args: string[], opts: { cwd: string }) => string} runGh
 * @returns {{ number: number, state: 'OPEN'|'CLOSED'|'MERGED', mergedAt: string|null, closedAt: string|null, headRefOid: string|null } | null}
 */
export function probeLatestPr(branch, cwd, runGh = defaultGhRunner) {
  const out = runGh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state,mergedAt,closedAt,headRefOid',
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
  const state =
    typeof row.state === 'string' ? row.state.toUpperCase() : 'UNKNOWN';
  return {
    number: Number(row.number) || 0,
    state,
    mergedAt: row.mergedAt ?? null,
    closedAt: row.closedAt ?? null,
    headRefOid: row.headRefOid ?? null,
  };
}

/**
 * Bulk-probe every open/closed/merged PR in one `gh` spawn, indexed by
 * head ref name.
 *
 * Replaces the N per-branch {@link probeLatestPr} spawns the planner used
 * to fire inside its branch loops (Story #3333, f-performance). A single
 * `gh pr list --state all` page is parsed into a `Map<headRefName,
 * prInfo>` whose values carry the **same** shape {@link probeLatestPr}
 * returns, so `classifyLatestPr` reads them without translation.
 *
 * When a head ref appears more than once on the page (multiple PRs share a
 * head — reused branch names), the **first** row wins. `gh pr list`
 * returns rows newest-first, so the first row is the latest PR on that
 * head — exactly the "latest PR" signal {@link probeLatestPr} resolves
 * per-branch. The planner keeps {@link probeLatestPr} as a per-branch
 * fallback for head refs absent from this page (a branch whose PR fell
 * outside the `--limit` window).
 *
 * Returns an empty Map on any failure (non-array, empty, or malformed
 * JSON) so the caller transparently falls back to per-branch probing.
 *
 * @param {string} cwd
 * @param {(args: string[], opts: { cwd: string }) => string} runGh
 * @param {number} limit  Max rows to fetch in the single page (default 1000).
 * @returns {Map<string, { number: number, state: string, mergedAt: string|null, closedAt: string|null, headRefOid: string|null }>}
 */
export function probeAllPrs(cwd, runGh = defaultGhRunner, limit = 1000) {
  const out = runGh(
    [
      'pr',
      'list',
      '--state',
      'all',
      '--json',
      'number,state,mergedAt,closedAt,headRefOid,headRefName',
      '--limit',
      String(limit),
    ],
    { cwd },
  );
  const trimmed = (out ?? '').trim();
  const index = new Map();
  if (!trimmed) return index;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return index;
  }
  if (!Array.isArray(parsed)) return index;
  for (const row of parsed) {
    const headRefName =
      typeof row?.headRefName === 'string' ? row.headRefName : null;
    if (!headRefName || index.has(headRefName)) continue;
    const state =
      typeof row.state === 'string' ? row.state.toUpperCase() : 'UNKNOWN';
    index.set(headRefName, {
      number: Number(row.number) || 0,
      state,
      mergedAt: row.mergedAt ?? null,
      closedAt: row.closedAt ?? null,
      headRefOid: row.headRefOid ?? null,
    });
  }
  return index;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Normalise a raw git SHA string: trim it and return it only when it
 * matches the 7–40 hex-char shape, else `null`. Shared by both the local
 * and remote-only resolution paths so the validation lives in one place.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function validSha(raw) {
  const sha = (raw ?? '').trim();
  return SHA_RE.test(sha) ? sha : null;
}

/**
 * Extract the leading SHA token from `git ls-remote` stdout. Returns the
 * first non-empty line's first whitespace-delimited field, or `''` when
 * stdout carries no usable line.
 *
 * @param {string} stdout
 * @returns {string}
 */
function firstLsRemoteSha(stdout) {
  const first = stdout
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return first ? (first.split(/\s+/)[0]?.trim() ?? '') : '';
}

/**
 * Resolve the current tip SHA of a branch.
 *
 * For branches that exist locally (`localExists: true`), reads
 * `refs/heads/<branch>` via `git rev-parse`. For remote-only branches,
 * reads the SHA from `git ls-remote --heads <remote> <branch>`. Returns
 * `null` when the ref cannot be resolved — callers treat that as "no
 * tip cross-check available" and skip the divergence guard rather than
 * failing the candidate.
 *
 * @param {{ cwd: string, branch: string, remoteName?: string, localExists?: boolean }} args
 * @returns {string | null}
 */
export function branchTipSha({
  cwd,
  branch,
  remoteName = 'origin',
  localExists = true,
}) {
  if (localExists) {
    const res = gitSpawn(cwd, 'rev-parse', `refs/heads/${branch}`);
    return res.status !== 0 ? null : validSha(res.stdout);
  }
  const res = gitSpawn(cwd, 'ls-remote', '--heads', remoteName, branch);
  return res.status !== 0 ? null : validSha(firstLsRemoteSha(res.stdout));
}

export const __testing = { validSha, firstLsRemoteSha };

/**
 * Pure-ish: classify a latest-PR probe row into a planner verdict.
 *
 * Centralizes the state-machine that decides whether a branch with a PR
 * row is reapable. Pulled out of {@link planCleanup} so the local and
 * remote-only branch walks share one source of truth.
 *
 * Inputs:
 *   - `prInfo`: the row from `prProbe` — may be the new latest-PR shape
 *     ({@link probeLatestPr}) carrying `state` + `headRefOid`, or the
 *     legacy shape ({@link probeMergedPr}) carrying only `number` +
 *     `mergedAt`. The absence of `state` is treated as MERGED so legacy
 *     callers and historical tests keep working.
 *   - `branch`, `localExists`, `remoteName`, `cwd`, `branchTipShaFn`: used
 *     to resolve the branch's current tip for the divergence cross-check.
 *
 * Returns either:
 *   - `{ kind: 'candidate', prInfo }` — caller appends a candidate.
 *   - `{ kind: 'skip', reason: <new-reason>, prNumber? }` — caller pushes
 *     into `skipped[]` and continues.
 *   - `{ kind: 'no-pr' }` — caller continues without skipping.
 *
 * @param {{
 *   prInfo: { number?: number, state?: string, mergedAt?: string|null, headRefOid?: string|null } | null,
 *   branch: string,
 *   cwd: string,
 *   remoteName: string,
 *   localExists: boolean,
 *   branchTipShaFn: (args: { cwd: string, branch: string, remoteName: string, localExists: boolean }) => string | null,
 * }} args
 * @returns {{ kind: 'candidate', prInfo: object } | { kind: 'skip', reason: string, prNumber?: number, tipSha?: string|null, mergedSha?: string|null } | { kind: 'no-pr' }}
 */
export function classifyLatestPr({
  prInfo,
  branch,
  cwd,
  remoteName,
  localExists,
  branchTipShaFn,
}) {
  if (!prInfo) return { kind: 'no-pr' };
  const state =
    typeof prInfo.state === 'string' ? prInfo.state.toUpperCase() : 'MERGED';
  if (state === 'OPEN') {
    return {
      kind: 'skip',
      reason: 'latest-pr-open',
      prNumber: prInfo.number ?? null,
    };
  }
  if (state === 'CLOSED') {
    return {
      kind: 'skip',
      reason: 'latest-pr-closed-not-merged',
      prNumber: prInfo.number ?? null,
    };
  }
  if (state !== 'MERGED') {
    return {
      kind: 'skip',
      reason: 'latest-pr-unknown-state',
      prNumber: prInfo.number ?? null,
    };
  }
  if (prInfo.headRefOid) {
    const tipSha = branchTipShaFn({ cwd, branch, remoteName, localExists });
    if (tipSha && tipSha !== prInfo.headRefOid) {
      return {
        kind: 'skip',
        reason: 'tip-diverged-from-merge',
        prNumber: prInfo.number ?? null,
        tipSha,
        mergedSha: prInfo.headRefOid,
      };
    }
  }
  return { kind: 'candidate', prInfo };
}
