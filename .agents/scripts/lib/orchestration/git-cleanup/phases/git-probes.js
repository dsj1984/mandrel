/**
 * Branch / worktree / PR probes for the git-cleanup branches planner; also
 * re-exports the fast-forward probes from `git-probes-ff.js`.
 *
 * @module lib/orchestration/git-cleanup/phases/git-probes
 */

import { execFileSync } from 'node:child_process';

import { gitSpawn } from '../../../git-utils.js';
import { parseWorktreePorcelain } from '../../../worktree-manager.js';
import { resolveMergedTip } from './merged-tip.js';

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

/**
 * Strip the `<remote>/` prefix and drop the symbolic HEAD, which
 * `%(refname:short)` may render as the bare remote name. Both spellings are
 * rejected on the raw line, before the strip, so a real branch named
 * `origin` (`origin/origin`) stays reapable. Shared by both remote listers so
 * their names match.
 *
 * @param {string} stdout
 * @param {string} remoteName
 * @returns {string[]}
 */
function shortRemoteNames(stdout, remoteName) {
  const prefix = `${remoteName}/`;
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => l !== 'HEAD' && l !== remoteName)
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l))
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
  return shortRemoteNames(res.stdout, remoteName);
}

/**
 * The remote-only walk's ancestry source: the `-r` twin of
 * {@link listMergedBranches} (which sees local heads only). Offline — reads
 * the already-fetched remote-tracking refs.
 *
 * @param {string} cwd
 * @param {string} base
 * @param {string} [remoteName]
 * @returns {string[]}
 */
/* node:coverage ignore next */
export function listRemoteMergedBranches(cwd, base, remoteName = 'origin') {
  const res = gitSpawn(
    cwd,
    'branch',
    '-r',
    '--merged',
    base,
    '--format=%(refname:short)',
  );
  if (res.status !== 0) return [];
  return shortRemoteNames(res.stdout, remoteName);
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

/**
 * Union the merged listing against the local base with the one against
 * `<remote>/<base>` (when it exists), so a stale local base cannot hide a
 * branch already merged on the remote. Shared by both walks.
 *
 * @param {{ lister: Function, cwd: string, baseBranch: string, remoteBaseRef: string, refExistsFn: Function, remoteName?: string }} args
 * @returns {Set<string>}
 */
export function freshAnchoredMergedSet({
  lister,
  cwd,
  baseBranch,
  remoteBaseRef,
  refExistsFn,
  remoteName,
}) {
  const set = new Set(lister(cwd, baseBranch, remoteName));
  if (refExistsFn(cwd, remoteBaseRef)) {
    for (const b of lister(cwd, remoteBaseRef, remoteName)) set.add(b);
  }
  return set;
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
// Synchronous on purpose: `planCleanup` is a sync planner.
export function defaultGhRunner(args, { cwd }) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8' });
}

/**
 * "Any merged PR on this head" — injectable as `prProbe`; the planner
 * defaults to {@link probeLatestPr}.
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
 * The latest PR on a head ref, any state — so a reused branch name is never
 * reaped on a stale historical merge. `headRefOid` lets the planner catch a
 * post-merge force-push.
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
 * Every PR in one `gh` spawn, indexed by head ref in {@link probeLatestPr}'s
 * shape. Rows are newest-first, so the first row per head wins.
 *
 * `complete` is true only when fewer rows than `limit` came back: then a
 * head's absence proves it has no PR and the per-branch fallback can be
 * skipped. Every failure reports `complete: false` so the fallback stays
 * armed; a parsed empty array is genuinely complete.
 *
 * @param {string} cwd
 * @param {(args: string[], opts: { cwd: string }) => string} runGh
 * @param {number} limit
 * @returns {{ index: Map<string, { number: number, state: string, mergedAt: string|null, closedAt: string|null, headRefOid: string|null }>, complete: boolean }}
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
  const truncated = { index, complete: false };
  if (!trimmed) return truncated;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return truncated;
  }
  if (!Array.isArray(parsed)) return truncated;
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
  return { index, complete: parsed.length < limit };
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * @param {string} raw
 * @returns {string | null}
 */
function validSha(raw) {
  const sha = (raw ?? '').trim();
  return SHA_RE.test(sha) ? sha : null;
}

/**
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
 * Local ref via rev-parse, remote-only via ls-remote. `null` means "no tip
 * cross-check available", not a failure.
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

/* node:coverage ignore next */
// Guards the `<remote>/<base>` ancestry union.
export function refExists(cwd, ref) {
  const res = gitSpawn(cwd, 'rev-parse', '--verify', '--quiet', ref);
  return res.status === 0;
}

/**
 * Last-commit time for the `not-merged` skip line; `localExists: false`
 * reads `refs/remotes/<remote>/<branch>`.
 *
 * @param {string} cwd
 * @param {string} branch
 * @param {{ localExists?: boolean, remoteName?: string }} [opts]
 * @returns {string | null}
 */
/* node:coverage ignore next */
export function branchLastCommitAt(cwd, branch, opts = {}) {
  const { localExists = true, remoteName = 'origin' } = opts;
  const ref = localExists
    ? `refs/heads/${branch}`
    : `refs/remotes/${remoteName}/${branch}`;
  const res = gitSpawn(cwd, 'log', '-1', '--format=%cI', ref, '--');
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * @param {string} stdout
 * @returns {string}
 */
function firstStdoutLine(stdout) {
  const first = (stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return first ?? '';
}

/**
 * `branch` is content-equivalent when `git merge-tree --write-tree` (git
 * >= 2.38) merges it cleanly into `base`'s own tree — its content landed by
 * another route (squash, cherry-pick). A non-zero exit (old git or a real
 * conflict) is inconclusive and reported as unsupported.
 *
 * @param {{ cwd: string, base: string, branch: string, spawn?: typeof gitSpawn }} args
 * @returns {{ supported: false } | { supported: true, equivalent: boolean }}
 */
export function probeContentEquivalent({
  cwd,
  base,
  branch,
  spawn = gitSpawn,
}) {
  const merged = spawn(cwd, 'merge-tree', '--write-tree', base, branch);
  if (merged.status !== 0) return { supported: false };
  const mergedTree = validSha(firstStdoutLine(merged.stdout));
  if (!mergedTree) return { supported: false };
  const baseTreeRes = spawn(
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    `${base}^{tree}`,
  );
  if (baseTreeRes.status !== 0) return { supported: false };
  const baseTree = validSha(baseTreeRes.stdout);
  if (!baseTree) return { supported: false };
  return { supported: true, equivalent: mergedTree === baseTree };
}

export const __testing = {
  validSha,
  firstLsRemoteSha,
  firstStdoutLine,
  shortRemoteNames,
};

/**
 * Classify a PR probe row into a planner verdict, shared by the local and
 * remote-only walks. A row without `state` ({@link probeMergedPr}'s shape)
 * counts as MERGED; a MERGED row's tip check is {@link resolveMergedTip}'s.
 *
 * @param {{
 *   prInfo: { number?: number, state?: string, mergedAt?: string|null, headRefOid?: string|null } | null,
 *   branch: string,
 *   cwd: string,
 *   remoteName: string,
 *   localExists: boolean,
 *   branchTipShaFn: (args: { cwd: string, branch: string, remoteName: string, localExists: boolean }) => string | null,
 *   ancestryFn?: Function,
 *   mergedTipFn?: typeof resolveMergedTip,
 * }} args
 * @returns {{ kind: 'candidate', prInfo: object, reason?: string, tipSha?: string, mergedSha?: string } | { kind: 'skip', reason: string, prNumber?: number, tipSha?: string|null, mergedSha?: string|null, detail?: string } | { kind: 'no-pr' }}
 */
export function classifyLatestPr({
  prInfo,
  branch,
  cwd,
  remoteName,
  localExists,
  branchTipShaFn,
  ancestryFn,
  mergedTipFn = resolveMergedTip,
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
  const tipVerdict = mergedTipFn({
    prInfo,
    branch,
    cwd,
    remoteName,
    localExists,
    branchTipShaFn,
    ancestryFn,
  });
  return tipVerdict ?? { kind: 'candidate', prInfo };
}
