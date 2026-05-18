#!/usr/bin/env node
/* node:coverage ignore file -- multi-phase repo-cleanup CLI; thin shell over `git` + `gh` */

/**
 * git-cleanup.js — Multi-phase local-repo cleanup pipeline.
 *
 * Runs up to four cleanup phases in order, each independently selectable:
 *
 *   1. fast-forward-main: `git fetch origin <base>` → `git merge --ff-only`
 *      on a clean working tree. Skips with a reason when the tree is dirty
 *      or the FF would not apply.
 *   2. prune-remotes:    `git fetch --prune <remote>` → drop stale
 *      `refs/remotes/<remote>/*` tracking refs.
 *   3. branches:         enumerate merged local branches via
 *      `gh pr list --state merged` + `git branch --merged <base>` and
 *      reap them (with attached worktrees first). Optional `--remote`
 *      also reaps `origin/<branch>` and runs a follow-up prune to drop
 *      trailing tracking refs left by `push --delete`. With `--remote`,
 *      the planner also enumerates `refs/remotes/origin/*` and emits
 *      remote-only candidates (no local ref) for any origin branch with
 *      a merged PR — these are reaped on the remote alone via
 *      `gh pr list --state merged`.
 *
 *      Skip taxonomy: the current HEAD branch is reported with
 *      `reason: 'current-head'` (operator can reap it after
 *      `git checkout <base>`); the base branch and any
 *      `branch.protectedBranches` entries are reported with
 *      `reason: 'protected'` (not reapable).
 *   4. stashes:          enumerate `git stash list` and offer to drop
 *      each entry (interactive y/N per stash, or `--drop-stashes <ref>`
 *      in JSON / non-interactive mode).
 *
 * With no phase flag, all four phases run sequentially. Passing any of
 * `--fast-forward-main`, `--prune-remotes`, `--branches`, `--stashes`
 * narrows the run to the selected set. A failure in one phase does NOT
 * short-circuit later phases — each phase's outcome is captured in the
 * JSON envelope and aggregated into the exit code.
 *
 * Flags:
 *   --dry-run            (default) enumerate candidates, mutate nothing.
 *   --execute            perform reap / merge / prune / stash drops.
 *   --remote             also reap `origin/<branch>` (requires --execute).
 *   --yes                non-interactive — skip per-step confirmations.
 *   --json               emit a structured JSON envelope on stdout.
 *   --fast-forward-main  run only the fast-forward-main phase.
 *   --prune-remotes      run only the prune-remotes phase.
 *   --branches           run only the merged-branch reap phase.
 *   --stashes            run only the stash triage phase.
 *   --drop-stashes <r>   in JSON / --yes mode, drop only the named stash
 *                        refs (repeatable). Without this flag, JSON mode
 *                        lists stashes but drops none.
 *   --include <glob>     branches phase: allow-list pattern (repeatable).
 *   --exclude <glob>     branches phase: deny-list pattern (repeatable).
 *   --base <branch>      override `project.baseBranch`.
 *   --cwd <path>         operate against a different checkout.
 *
 * Exit codes:
 *   0 — clean (dry-run preview, or every active phase succeeded).
 *   1 — at least one phase reported a failure.
 *   2 — every active phase produced nothing to do (informational).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import picomatch from 'picomatch';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import {
  deleteBranchLocal,
  deleteBranchRemote,
} from './lib/git-branch-cleanup.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { parseWorktreePorcelain } from './lib/worktree-manager.js';

const TAG = '[git-cleanup]';

/**
 * Pure: parse argv into the normalized CLI option bag. Exported for tests.
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   execute: boolean,
 *   remote: boolean,
 *   yes: boolean,
 *   json: boolean,
 *   phases: { fastForwardMain: boolean, pruneRemotes: boolean, branches: boolean, stashes: boolean },
 *   include: string[],
 *   exclude: string[],
 *   dropStashes: string[],
 *   base: string|null,
 *   cwd: string|null,
 * }}
 */
export function parseCleanupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'fast-forward-main': { type: 'boolean', default: false },
      'prune-remotes': { type: 'boolean', default: false },
      branches: { type: 'boolean', default: false },
      stashes: { type: 'boolean', default: false },
      include: { type: 'string', multiple: true, default: [] },
      exclude: { type: 'string', multiple: true, default: [] },
      'drop-stashes': { type: 'string', multiple: true, default: [] },
      base: { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const execute = values.execute === true && values['dry-run'] !== true;
  const anyPhaseFlag =
    values['fast-forward-main'] === true ||
    values['prune-remotes'] === true ||
    values.branches === true ||
    values.stashes === true;
  const allPhases = !anyPhaseFlag;
  return {
    dryRun: !execute,
    execute,
    remote: values.remote === true,
    yes: values.yes === true,
    json: values.json === true,
    phases: {
      fastForwardMain: allPhases || values['fast-forward-main'] === true,
      pruneRemotes: allPhases || values['prune-remotes'] === true,
      branches: allPhases || values.branches === true,
      stashes: allPhases || values.stashes === true,
    },
    include: Array.isArray(values.include) ? values.include : [],
    exclude: Array.isArray(values.exclude) ? values.exclude : [],
    dropStashes: Array.isArray(values['drop-stashes'])
      ? values['drop-stashes']
      : [],
    base: typeof values.base === 'string' ? values.base : null,
    cwd: typeof values.cwd === 'string' ? values.cwd : null,
  };
}

/**
 * Pure: build a `(branch) => boolean` filter from include/exclude globs.
 *
 * @param {{ include?: string[], exclude?: string[] }} opts
 * @returns {(branch: string) => boolean}
 */
export function buildGlobFilter({ include = [], exclude = [] } = {}) {
  const includeMatch = include.length > 0 ? picomatch(include) : () => true;
  const excludeMatch = exclude.length > 0 ? picomatch(exclude) : () => false;
  return (branch) => includeMatch(branch) && !excludeMatch(branch);
}

/**
 * Pure: compute the protected-branch skip set.
 *
 * @param {{ baseBranch: string, currentBranch: string|null, configured: string[] }} opts
 * @returns {Set<string>}
 */
export function computeProtectedSet({ baseBranch, currentBranch, configured }) {
  const set = new Set();
  if (baseBranch) set.add(baseBranch);
  if (currentBranch) set.add(currentBranch);
  for (const name of configured ?? []) {
    if (name) set.add(name);
  }
  return set;
}

/**
 * Pure: classify why a branch is protected, with the distinction the dry-run
 * renderer needs to surface to the operator. Returns `null` when the branch
 * is NOT protected.
 *
 * Precedence (highest → lowest):
 *   - `'protected'` — branch is the base branch, OR appears in the
 *     `branch.protectedBranches` git config. Operator cannot reap it.
 *   - `'current-head'` — branch is the current HEAD (and not also base /
 *     configured). Operator can reap it after `git checkout <base>`.
 *
 * The `'current-head'` reason is split out so `renderDryRun` can emit a
 * remediation hint distinct from the generic `'protected'` line.
 *
 * @param {{ baseBranch: string, currentBranch: string|null, configured: string[], branch: string }} opts
 * @returns {'protected' | 'current-head' | null}
 */
export function computeProtectedReason({
  baseBranch,
  currentBranch,
  configured,
  branch,
}) {
  if (!branch) return null;
  if (baseBranch && branch === baseBranch) return 'protected';
  if (Array.isArray(configured) && configured.includes(branch))
    return 'protected';
  if (currentBranch && branch === currentBranch) return 'current-head';
  return null;
}

/* node:coverage ignore next */
function listLocalBranches(cwd) {
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
function listRemoteBranches(cwd, remoteName = 'origin') {
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
function listMergedBranches(cwd, base) {
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
function currentBranch(cwd) {
  const res = gitSpawn(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/* node:coverage ignore next */
function readProtectedConfig(cwd) {
  const res = gitSpawn(cwd, 'config', '--get', 'branch.protectedBranches');
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* node:coverage ignore next */
function worktreesByBranch(cwd) {
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

/**
 * Check whether a branch has a merged PR via `gh`.
 *
 * Legacy probe: queries `--state merged` and returns the first merged row's
 * `{ number, mergedAt }`. Kept exported so older call sites and tests that
 * predate the latest-PR-state model continue to work — the planner now
 * defaults to {@link probeLatestPr} for the bug-A correctness fix, but a
 * caller can still inject this as `prProbe` to opt into the historical
 * "any merge on this head" semantics.
 *
 * @param {string} branch
 * @param {string} cwd
 * @param {(args: string[], opts: { cwd: string }) => string} runGh
 * @returns {{ number: number, mergedAt: string|null } | null}
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

/* node:coverage ignore next */
function defaultGhRunner(args, { cwd }) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8' });
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
    if (res.status !== 0) return null;
    const sha = res.stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  }
  const res = gitSpawn(cwd, 'ls-remote', '--heads', remoteName, branch);
  if (res.status !== 0) return null;
  const first = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return null;
  const sha = first.split(/\s+/)[0]?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

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
 *
 * @param {{
 *   prInfo: { number?: number, state?: string, mergedAt?: string|null, headRefOid?: string|null } | null,
 *   branch: string,
 *   cwd: string,
 *   remoteName: string,
 *   localExists: boolean,
 *   branchTipShaFn: (args: { cwd: string, branch: string, remoteName: string, localExists: boolean }) => string | null,
 * }} args
 * @returns {{ kind: 'candidate', prInfo: object } | { kind: 'skip', reason: string, prNumber?: number, tipSha?: string|null, mergedSha?: string|null }}
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

/**
 * Pure-ish: enumerate merged-branch candidates given the injected accessors.
 *
 * When `includeRemoteOnly` is `true`, also walks `refs/remotes/<remoteName>/*`
 * and emits candidates for branches that exist on the remote with a merged
 * PR but have no local ref. These remote-only candidates carry
 * `localExists: false` so `executeCleanup` knows to skip the
 * `deleteBranchLocal` call and run only the remote deletion path.
 *
 * The PR probe defaults to {@link probeLatestPr} so the planner classifies
 * each candidate by the **latest** PR on the head ref rather than any
 * historical merge. Branches whose latest PR is OPEN or CLOSED-not-merged
 * are skipped with `reason: 'latest-pr-open'` /
 * `reason: 'latest-pr-closed-not-merged'`. When the latest PR is MERGED
 * but the branch tip has diverged from the PR's `headRefOid` (post-merge
 * force-push), the branch is skipped with
 * `reason: 'tip-diverged-from-merge'`.
 */
export function planCleanup(ctx) {
  const {
    cwd,
    baseBranch,
    localLister = listLocalBranches,
    mergedLister = listMergedBranches,
    currentBranchFn = currentBranch,
    protectedConfigFn = readProtectedConfig,
    worktreesFn = worktreesByBranch,
    prProbe = (b, c) => probeLatestPr(b, c),
    branchTipShaFn = branchTipSha,
    filter = () => true,
    includeRemoteOnly = false,
    remoteLister = listRemoteBranches,
    remoteName = 'origin',
  } = ctx;

  const resolvedCurrent = currentBranchFn(cwd);
  const resolvedConfigured = protectedConfigFn(cwd);
  const classify = (branch) =>
    computeProtectedReason({
      baseBranch,
      currentBranch: resolvedCurrent,
      configured: resolvedConfigured,
      branch,
    });

  const wtMap = worktreesFn(cwd);
  const mergedByGit = new Set(mergedLister(cwd, baseBranch));
  const localBranches = localLister(cwd);
  const localSet = new Set(localBranches);

  const candidates = [];
  const skipped = [];

  for (const branch of localBranches) {
    const protectedReason = classify(branch);
    if (protectedReason) {
      skipped.push({ branch, reason: protectedReason });
      continue;
    }
    if (!filter(branch)) {
      skipped.push({ branch, reason: 'filtered' });
      continue;
    }

    const prInfo = prProbe(branch, cwd);
    const verdict = classifyLatestPr({
      prInfo,
      branch,
      cwd,
      remoteName,
      localExists: true,
      branchTipShaFn,
    });

    if (verdict.kind === 'skip') {
      const entry = { branch, reason: verdict.reason };
      if (verdict.prNumber != null) entry.prNumber = verdict.prNumber;
      if (verdict.tipSha) entry.tipSha = verdict.tipSha;
      if (verdict.mergedSha) entry.mergedSha = verdict.mergedSha;
      skipped.push(entry);
      continue;
    }

    let detectedBy = null;
    let resolvedPrInfo = null;
    if (verdict.kind === 'candidate') {
      detectedBy = 'gh';
      resolvedPrInfo = verdict.prInfo;
    } else if (mergedByGit.has(branch)) {
      detectedBy = 'git-merged';
    } else {
      skipped.push({ branch, reason: 'not-merged' });
      continue;
    }

    const wt = wtMap.get(branch);
    candidates.push({
      branch,
      prNumber: resolvedPrInfo?.number ?? null,
      mergedAt: resolvedPrInfo?.mergedAt ?? null,
      hasWorktree: !!wt,
      worktreePath: wt?.path ?? null,
      detectedBy,
      localExists: true,
    });
  }

  if (includeRemoteOnly) {
    const remoteBranches = remoteLister(cwd, remoteName);
    for (const branch of remoteBranches) {
      if (localSet.has(branch)) continue;
      if (classify(branch)) continue;
      if (!filter(branch)) continue;

      const prInfo = prProbe(branch, cwd);
      const verdict = classifyLatestPr({
        prInfo,
        branch,
        cwd,
        remoteName,
        localExists: false,
        branchTipShaFn,
      });
      if (verdict.kind === 'no-pr') continue;
      if (verdict.kind === 'skip') {
        const entry = { branch, reason: verdict.reason };
        if (verdict.prNumber != null) entry.prNumber = verdict.prNumber;
        if (verdict.tipSha) entry.tipSha = verdict.tipSha;
        if (verdict.mergedSha) entry.mergedSha = verdict.mergedSha;
        skipped.push(entry);
        continue;
      }

      candidates.push({
        branch,
        prNumber: verdict.prInfo.number ?? null,
        mergedAt: verdict.prInfo.mergedAt ?? null,
        hasWorktree: false,
        worktreePath: null,
        detectedBy: 'remote-only',
        localExists: false,
      });
    }
  }

  return { candidates, skipped };
}

/** Pure-ish: execute the branch reap plan. */
export function executeCleanup(ctx) {
  const {
    candidates,
    cwd,
    remote,
    removeWorktreeFn = removeWorktree,
    deleteLocalFn = (b, c) => deleteBranchLocal(b, { cwd: c, force: true }),
    deleteRemoteFn = (b, c) => deleteBranchRemote(b, { cwd: c }),
    pruneRemoteFn = pruneRemoteTracking,
    remoteName = 'origin',
    logger = Logger,
  } = ctx;

  const worktrees = [];
  const local = [];
  const remoteResults = [];
  const failures = [];

  for (const cand of candidates) {
    if (cand.hasWorktree && cand.worktreePath) {
      const wtRes = removeWorktreeFn(cand.worktreePath, cwd);
      worktrees.push({
        path: cand.worktreePath,
        ok: wtRes.ok,
        dirty: wtRes.dirty,
        stderr: wtRes.stderr,
      });
      if (wtRes.dirty) {
        logger.warn?.(
          `${TAG} ⚠️ dirty worktree force-removed: ${cand.worktreePath}`,
        );
      }
      if (!wtRes.ok) {
        failures.push({
          branch: cand.branch,
          scope: 'worktree',
          stderr: wtRes.stderr,
        });
        continue;
      }
    }

    // Remote-only candidates have no local ref, so the deleteLocalFn call
    // would fail with `not-found`. Skip it and proceed to the remote
    // deletion path.
    if (cand.localExists !== false) {
      const localRes = deleteLocalFn(cand.branch, cwd);
      local.push({
        branch: cand.branch,
        ok: localRes.deleted,
        reason: localRes.reason,
        alreadyGone: localRes.reason === 'not-found',
        stderr: localRes.stderr,
      });
      if (!localRes.deleted) {
        failures.push({
          branch: cand.branch,
          scope: 'local',
          reason: localRes.reason,
          stderr: localRes.stderr,
        });
        continue;
      }
    }

    if (remote) {
      const remoteRes = deleteRemoteFn(cand.branch, cwd);
      remoteResults.push({
        branch: cand.branch,
        ok: remoteRes.deleted,
        reason: remoteRes.reason,
        alreadyGone: remoteRes.reason === 'not-found',
        stderr: remoteRes.stderr,
      });
      if (!remoteRes.deleted) {
        failures.push({
          branch: cand.branch,
          scope: 'remote',
          reason: remoteRes.reason,
          stderr: remoteRes.stderr,
        });
      }
    }
  }

  let prune = null;
  if (remote && remoteResults.length > 0) {
    const pruneRes = pruneRemoteFn(cwd, remoteName);
    prune = {
      attempted: true,
      ok: pruneRes.ok,
      remote: remoteName,
      pruned: pruneRes.pruned ?? [],
      stderr: pruneRes.stderr,
    };
    if (!pruneRes.ok) {
      failures.push({
        branch: null,
        scope: 'prune',
        stderr: pruneRes.stderr,
      });
    }
  }

  return {
    worktrees,
    local,
    remote: remoteResults,
    prune,
    failures,
    ok: failures.length === 0,
  };
}

/**
 * Pure-ish: plan the fast-forward-main phase. Inspects the working tree
 * and the local-vs-remote ref relationship to decide whether a fast-forward
 * is even possible.
 */
export function planFastForward(ctx) {
  const {
    cwd,
    baseBranch,
    remoteName = 'origin',
    isCleanFn = isWorkingTreeClean,
    currentBranchFn = currentBranch,
    fetchFn = fetchRef,
    canFastForwardFn = canFastForward,
  } = ctx;

  if (!isCleanFn(cwd)) {
    return { runnable: false, reason: 'dirty-tree' };
  }
  const fetchRes = fetchFn(cwd, remoteName, baseBranch);
  if (!fetchRes.ok) {
    return { runnable: false, reason: 'fetch-failed', stderr: fetchRes.stderr };
  }
  const cur = currentBranchFn(cwd);
  const ff = canFastForwardFn(cwd, baseBranch, remoteName);
  if (!ff.ok) {
    return {
      runnable: false,
      reason: ff.reason ?? 'not-fast-forward',
      currentBranch: cur,
    };
  }
  if (ff.behind === 0) {
    return {
      runnable: false,
      reason: 'already-up-to-date',
      behind: 0,
      currentBranch: cur,
    };
  }
  return { runnable: true, behind: ff.behind, currentBranch: cur };
}

/** Execute the fast-forward-main phase. */
export function executeFastForward(ctx) {
  const {
    cwd,
    baseBranch,
    remoteName = 'origin',
    plan,
    checkoutFn = checkoutBranch,
    mergeFn = mergeFastForward,
    logger = Logger,
  } = ctx;

  if (!plan.runnable) {
    logger.info?.(
      `${TAG} ⏭️  fast-forward ${baseBranch} skipped: ${plan.reason ?? 'unknown'}`,
    );
    return {
      ok: true,
      applied: false,
      skipped: true,
      reason: plan.reason,
      behind: plan.behind,
    };
  }

  if (plan.currentBranch && plan.currentBranch !== baseBranch) {
    const co = checkoutFn(cwd, baseBranch);
    if (!co.ok) {
      logger.warn?.(`${TAG} ❌ checkout ${baseBranch} failed: ${co.stderr}`);
      return {
        ok: false,
        applied: false,
        skipped: false,
        reason: 'checkout-failed',
        stderr: co.stderr,
      };
    }
  }

  const ref = `${remoteName}/${baseBranch}`;
  const mergeRes = mergeFn(cwd, ref);
  if (!mergeRes.ok) {
    logger.warn?.(
      `${TAG} ❌ merge --ff-only ${ref} failed: ${mergeRes.stderr}`,
    );
    return {
      ok: false,
      applied: false,
      skipped: false,
      reason: 'merge-failed',
      stderr: mergeRes.stderr,
    };
  }
  logger.info?.(
    `${TAG} ✅ fast-forwarded ${baseBranch} by ${plan.behind} commit(s)`,
  );
  return { ok: true, applied: true, skipped: false, behind: plan.behind };
}

/**
 * Execute the prune-remotes phase. Thin wrapper around `pruneRemoteTracking`
 * so the orchestrator can treat it uniformly with the other phases.
 */
export function executePrune(ctx) {
  const {
    cwd,
    remoteName = 'origin',
    pruneFn = pruneRemoteTracking,
    logger = Logger,
  } = ctx;
  const res = pruneFn(cwd, remoteName);
  if (!res.ok) {
    logger.warn?.(`${TAG} ❌ prune ${remoteName} failed: ${res.stderr}`);
    return {
      ok: false,
      attempted: true,
      remote: remoteName,
      pruned: [],
      stderr: res.stderr,
    };
  }
  if ((res.pruned ?? []).length === 0) {
    logger.info?.(`${TAG} ✅ prune ${remoteName} (no stale refs)`);
  } else {
    logger.info?.(
      `${TAG} ✅ prune ${remoteName} (dropped ${res.pruned.length} stale ref(s))`,
    );
  }
  return {
    ok: true,
    attempted: true,
    remote: remoteName,
    pruned: res.pruned ?? [],
  };
}

/**
 * Pure: parse `git stash list --format='%gd|%ci|%s'` output into structured
 * stash entries.
 *
 * @param {string} stdout
 * @returns {Array<{ ref: string, createdAt: string, message: string }>}
 */
export function parseStashList(stdout) {
  const out = [];
  for (const raw of (stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf('|');
    if (idx < 0) continue;
    const ref = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1);
    const idx2 = rest.indexOf('|');
    if (idx2 < 0) continue;
    const createdAt = rest.slice(0, idx2).trim();
    const message = rest.slice(idx2 + 1).trim();
    if (!ref) continue;
    out.push({ ref, createdAt, message });
  }
  return out;
}

/* node:coverage ignore next */
function listStashes(cwd) {
  const res = gitSpawn(cwd, 'stash', 'list', '--format=%gd|%ci|%s');
  if (res.status !== 0) return [];
  return parseStashList(res.stdout);
}

/** Plan the stash phase: enumerate stashes, no mutation. */
export function planStashes(ctx) {
  const { cwd, stashListerFn = listStashes } = ctx;
  return { stashes: stashListerFn(cwd) };
}

/**
 * Execute the stash phase. Dispatches per-stash via the injected `decideFn`
 * so interactive prompts (readline) and non-interactive allowlists
 * (`--drop-stashes <ref>`) share the same engine.
 */
export function executeStashes(ctx) {
  const { cwd, stashes, decideFn, dropFn = dropStash, logger = Logger } = ctx;
  const actions = [];
  const failures = [];
  let quit = false;

  // Drop stashes high-index-first so the indices of remaining stashes stay
  // stable across calls — git renumbers from the top of the stack.
  const ordered = [...stashes].sort(
    (a, b) => stashRefIndex(b.ref) - stashRefIndex(a.ref),
  );

  for (const s of ordered) {
    if (quit) {
      actions.push({ ref: s.ref, action: 'quit' });
      continue;
    }
    const decision = decideFn(s);
    if (decision === 'quit') {
      quit = true;
      actions.push({ ref: s.ref, action: 'quit' });
      continue;
    }
    if (decision === 'keep') {
      actions.push({ ref: s.ref, action: 'keep' });
      continue;
    }
    const res = dropFn(s.ref, cwd);
    if (res.ok) {
      logger.info?.(`${TAG} ✅ dropped ${s.ref}: ${s.message}`);
      actions.push({ ref: s.ref, action: 'drop', dropped: true });
    } else {
      logger.warn?.(`${TAG} ❌ drop ${s.ref} failed: ${res.stderr}`);
      actions.push({
        ref: s.ref,
        action: 'drop',
        dropped: false,
        stderr: res.stderr,
      });
      failures.push({ ref: s.ref, stderr: res.stderr });
    }
  }
  return { ok: failures.length === 0, actions, failures };
}

/**
 * Pure: extract the numeric index from a stash ref like `stash@{3}`.
 *
 * @param {string} ref
 * @returns {number}
 */
export function stashRefIndex(ref) {
  const m = /^stash@\{(\d+)\}$/.exec(ref ?? '');
  return m ? Number(m[1]) : -1;
}

/* node:coverage ignore next */
function dropStash(ref, cwd) {
  const res = gitSpawn(cwd, 'stash', 'drop', ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/**
 * Build a non-interactive `decideFn` that drops stashes whose refs appear in
 * `allowlist`, and keeps every other stash. Used in JSON / --yes mode.
 */
export function buildAllowlistDecider(allowlist) {
  const set = new Set(allowlist ?? []);
  return (entry) => (set.has(entry.ref) ? 'drop' : 'keep');
}

/* node:coverage ignore next */
function pruneRemoteTracking(cwd, remoteName) {
  const res = gitSpawn(cwd, 'fetch', '--prune', '--quiet', remoteName);
  if (res.status !== 0) {
    return { ok: false, pruned: [], stderr: res.stderr };
  }
  return {
    ok: true,
    pruned: parsePrunedRefs(res.stderr, remoteName),
  };
}

/**
 * Pure: extract the short ref names from `git fetch --prune` stderr.
 */
export function parsePrunedRefs(output, remoteName) {
  const prefix = `${remoteName}/`;
  const out = [];
  for (const raw of (output ?? '').split('\n')) {
    const line = raw.trim();
    let m = line.match(/^-\s+\[deleted\]\s+\S+\s+->\s+(.+)$/);
    if (!m) m = line.match(/^\*\s+\[pruned\]\s+(.+)$/);
    if (!m) continue;
    const ref = m[1].trim();
    out.push(ref.startsWith(prefix) ? ref.slice(prefix.length) : ref);
  }
  return out;
}

/* node:coverage ignore next */
function isWorkingTreeClean(cwd) {
  const res = gitSpawn(cwd, 'status', '--porcelain');
  if (res.status !== 0) return false;
  return res.stdout.trim() === '';
}

/* node:coverage ignore next */
function fetchRef(cwd, remoteName, ref) {
  const res = gitSpawn(cwd, 'fetch', '--quiet', remoteName, ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/* node:coverage ignore next */
function canFastForward(cwd, baseBranch, remoteName) {
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
function checkoutBranch(cwd, branch) {
  const res = gitSpawn(cwd, 'checkout', branch);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/* node:coverage ignore next */
function mergeFastForward(cwd, ref) {
  const res = gitSpawn(cwd, 'merge', '--ff-only', ref);
  if (res.status !== 0) return { ok: false, stderr: res.stderr };
  return { ok: true };
}

/* node:coverage ignore next */
function removeWorktree(worktreePath, cwd) {
  const plain = gitSpawn(cwd, 'worktree', 'remove', worktreePath);
  if (plain.status === 0) {
    return { ok: true, dirty: false };
  }
  const forced = gitSpawn(cwd, 'worktree', 'remove', '--force', worktreePath);
  if (forced.status === 0) {
    return { ok: true, dirty: true, stderr: plain.stderr };
  }
  return {
    ok: false,
    dirty: true,
    stderr: forced.stderr || plain.stderr,
  };
}

/** Pure: render the dry-run plan as the operator-facing text block. */
export function renderDryRun(plan, opts = {}) {
  const { baseBranch = null } = opts;
  const lines = [
    `${TAG} DRY RUN (nothing deleted) — ${plan.candidates.length} candidate(s)`,
  ];
  if (plan.candidates.length === 0) {
    lines.push('  (no merged branches to clean up)');
  } else {
    for (const c of plan.candidates) {
      const pr = c.prNumber ? `PR #${c.prNumber}` : c.detectedBy;
      const wt = c.hasWorktree ? ` (worktree: ${c.worktreePath})` : '';
      const remoteOnly = c.localExists === false ? ' (remote-only)' : '';
      lines.push(`  • ${c.branch} — ${pr}${wt}${remoteOnly}`);
    }
  }
  const skipped = plan.skipped ?? [];
  const currentHeadSkip = skipped.find((s) => s.reason === 'current-head');
  if (currentHeadSkip) {
    const hint = baseBranch
      ? `checkout ${baseBranch} first to include this branch`
      : 'checkout the base branch first to include this branch';
    lines.push(
      `${TAG} ⓘ ${currentHeadSkip.branch} skipped — current HEAD (${hint})`,
    );
  }
  for (const skip of skipped) {
    const line = renderLatestPrSkipLine(skip);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Pure: render a single latest-PR-state skip line. Returns null when the
 * skip reason is not one of the latest-PR family — `renderDryRun` filters
 * by truthy return value so unrelated skip reasons (`protected`,
 * `current-head`, `filtered`, `not-merged`) stay quiet.
 *
 * @param {{ branch: string, reason: string, prNumber?: number, tipSha?: string, mergedSha?: string }} skip
 * @returns {string | null}
 */
export function renderLatestPrSkipLine(skip) {
  if (!skip) return null;
  const prRef = skip.prNumber ? `PR #${skip.prNumber}` : 'latest PR';
  if (skip.reason === 'latest-pr-closed-not-merged') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} was closed without merging`;
  }
  if (skip.reason === 'latest-pr-open') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} is still open`;
  }
  if (skip.reason === 'tip-diverged-from-merge') {
    const tip = skip.tipSha ? skip.tipSha.slice(0, 7) : '<unknown>';
    const merged = skip.mergedSha ? skip.mergedSha.slice(0, 7) : '<unknown>';
    return `${TAG} ⏭️  ${skip.branch} skipped — tip ${tip} diverges from ${prRef}'s merged ${merged} (post-merge force-push)`;
  }
  if (skip.reason === 'latest-pr-unknown-state') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} has an unrecognized state`;
  }
  return null;
}

/** Pure: render a per-branch execution line. */
export function renderExecutionLine(entry, scope) {
  const icon = entry.ok ? '✅' : '❌';
  const label = scope.padEnd(8);
  const tag =
    scope === 'local' || scope === 'remote' ? entry.branch : entry.path;
  const note = entry.alreadyGone
    ? ' (already gone)'
    : entry.dirty
      ? ' (forced — was dirty)'
      : '';
  return `${TAG} ${icon} ${label} ${tag}${note}`;
}

/** Pure: render the optional prune line. */
export function renderPruneLine(prune) {
  if (!prune?.attempted) return null;
  if (!prune.ok) {
    return `${TAG} ❌ prune    ${prune.remote} (${prune.stderr ?? 'failed'})`;
  }
  if (prune.pruned.length === 0) {
    return `${TAG} ✅ prune    ${prune.remote} (no stale refs)`;
  }
  const list = prune.pruned.map((n) => `${prune.remote}/${n}`).join(', ');
  return `${TAG} ✅ prune    ${prune.remote} (dropped ${prune.pruned.length} stale ref(s): ${list})`;
}

/** Pure: render the trailing summary line. */
export function renderExecutionSummary(result) {
  if (!result.ok) {
    return `${TAG} ❌ ${result.failures.length} failure(s) during cleanup.`;
  }
  const prunedCount = result.prune?.pruned?.length ?? 0;
  const pruneNote =
    prunedCount > 0 ? ` + ${prunedCount} stale tracking ref(s)` : '';
  return `${TAG} ✅ Reaped ${result.local.length} local + ${result.remote.length} remote + ${result.worktrees.length} worktree(s)${pruneNote}.`;
}

const EMPTY_RESULT = Object.freeze({
  worktrees: [],
  local: [],
  remote: [],
  prune: null,
  failures: [],
  ok: true,
});

/** Pure: build the JSON envelope emitted in `--json` mode. */
export function buildJsonEnvelope({
  dryRun,
  baseBranch,
  plan,
  result,
  fastForward = null,
  prune = null,
  stashes = null,
}) {
  const r = result ?? EMPTY_RESULT;
  return {
    dryRun,
    baseBranch,
    candidates: plan.candidates,
    skipped: plan.skipped,
    worktrees: r.worktrees,
    local: r.local,
    remote: r.remote,
    prune: r.prune ?? prune ?? null,
    fastForward,
    stashes,
    failures: r.failures,
    ok: r.ok,
  };
}

/**
 * Pure: derive the process exit code. Supports both the legacy
 * `(plan, result)` signature and the new multi-phase context object.
 *
 * @param {{ candidates?: Array, branchesPlan?: object, branchesResult?: object, fastForward?: object, prune?: object, stashes?: object } | { candidates: Array }} ctx
 * @param {{ ok: boolean } | null | undefined} [legacyResult]
 * @returns {0 | 1 | 2}
 */
export function computeExitCode(ctx, legacyResult) {
  if (legacyResult !== undefined || Array.isArray(ctx?.candidates)) {
    const plan = ctx;
    const result = legacyResult;
    if ((plan?.candidates?.length ?? 0) === 0) return 2;
    if (result && !result.ok) return 1;
    return 0;
  }
  const {
    branchesPlan = null,
    branchesResult = null,
    fastForward = null,
    prune = null,
    stashes = null,
  } = ctx ?? {};
  const anyFailure =
    (branchesResult && !branchesResult.ok) ||
    (fastForward && !fastForward.ok) ||
    (prune && !prune.ok) ||
    (stashes && !stashes.ok);
  if (anyFailure) return 1;
  const anyWork =
    (branchesPlan && branchesPlan.candidates.length > 0) ||
    fastForward?.applied ||
    (prune && (prune.pruned?.length ?? 0) > 0) ||
    (stashes &&
      (stashes.actions ?? []).some((a) => a.action === 'drop' && a.dropped));
  if (!anyWork) return 2;
  return 0;
}

/* node:coverage ignore next */
function emitDryRunHuman(plan, baseBranch) {
  for (const line of renderDryRun(plan, { baseBranch })) Logger.info(line);
}

/* node:coverage ignore next */
function emitExecutionHuman(result) {
  for (const r of result.worktrees)
    Logger.info(renderExecutionLine(r, 'worktree'));
  for (const r of result.local) Logger.info(renderExecutionLine(r, 'local'));
  for (const r of result.remote) Logger.info(renderExecutionLine(r, 'remote'));
  const pruneLine = renderPruneLine(result.prune);
  if (pruneLine) Logger.info(pruneLine);
  const summary = renderExecutionSummary(result);
  if (result.ok) Logger.info(summary);
  else Logger.error(summary);
}

/* node:coverage ignore next */
function resolveBaseBranch(cwd, override) {
  if (override) return override;
  try {
    const cfg = resolveConfig({ cwd });
    return cfg?.project?.baseBranch || cfg?.agentSettings?.baseBranch || 'main';
  } catch {
    return 'main';
  }
}

/* node:coverage ignore next */
async function promptYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans = await new Promise((resolve) => {
      rl.question(`${question} [y/N] `, (a) => resolve(a));
    });
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/* node:coverage ignore next */
async function promptStashDecision(entry) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans = await new Promise((resolve) => {
      rl.question(
        `${TAG} ${entry.ref} (${entry.createdAt}) ${entry.message} — drop/keep/quit [k]? `,
        (a) => resolve(a),
      );
    });
    const t = (ans ?? '').trim().toLowerCase();
    if (t === 'd' || t === 'drop' || t === 'y' || t === 'yes') return 'drop';
    if (t === 'q' || t === 'quit') return 'quit';
    return 'keep';
  } finally {
    rl.close();
  }
}

/* node:coverage ignore next */
async function runFastForwardPhase(opts, cwd, baseBranch) {
  Logger.info(`${TAG} ── phase: fast-forward-main ──`);
  const plan = planFastForward({ cwd, baseBranch });
  if (!plan.runnable) {
    Logger.info(`${TAG} ⏭️  ${baseBranch} skipped: ${plan.reason}`);
    return {
      ok: true,
      applied: false,
      skipped: true,
      reason: plan.reason,
      behind: plan.behind ?? 0,
    };
  }
  if (opts.dryRun) {
    Logger.info(
      `${TAG} DRY RUN — would fast-forward ${baseBranch} by ${plan.behind} commit(s)`,
    );
    return {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'dry-run',
      behind: plan.behind,
    };
  }
  if (!opts.yes) {
    const go = await promptYesNo(
      `${TAG} Fast-forward ${baseBranch} by ${plan.behind} commit(s)?`,
    );
    if (!go) {
      return {
        ok: true,
        applied: false,
        skipped: true,
        reason: 'declined',
        behind: plan.behind,
      };
    }
  }
  return executeFastForward({ cwd, baseBranch, plan });
}

/* node:coverage ignore next */
async function runPrunePhase(opts, cwd) {
  Logger.info(`${TAG} ── phase: prune-remotes ──`);
  if (opts.dryRun) {
    Logger.info(`${TAG} DRY RUN — would run \`git fetch --prune origin\``);
    return { ok: true, attempted: false, remote: 'origin', pruned: [] };
  }
  if (!opts.yes) {
    const go = await promptYesNo(
      `${TAG} Run \`git fetch --prune origin\` to drop stale tracking refs?`,
    );
    if (!go) {
      return {
        ok: true,
        attempted: false,
        remote: 'origin',
        pruned: [],
        reason: 'declined',
      };
    }
  }
  return executePrune({ cwd });
}

/* node:coverage ignore next */
async function runBranchPhase(opts, cwd, baseBranch) {
  Logger.info(`${TAG} ── phase: branches ──`);
  const filter = buildGlobFilter({
    include: opts.include,
    exclude: opts.exclude,
  });
  const plan = planCleanup({
    cwd,
    baseBranch,
    filter,
    includeRemoteOnly: opts.remote === true,
  });
  emitDryRunHuman(plan, baseBranch);
  if (opts.dryRun || plan.candidates.length === 0) {
    return { plan, result: null };
  }
  if (!opts.yes) {
    const go = await promptYesNo(
      `${TAG} Reap ${plan.candidates.length} merged branch(es)${opts.remote ? ' (including origin)' : ''}?`,
    );
    if (!go) {
      return { plan, result: null, declined: true };
    }
  }
  const result = executeCleanup({
    candidates: plan.candidates,
    cwd,
    remote: opts.remote,
  });
  emitExecutionHuman(result);
  return { plan, result };
}

/* node:coverage ignore next */
async function runStashPhase(opts, cwd) {
  Logger.info(`${TAG} ── phase: stashes ──`);
  const { stashes } = planStashes({ cwd });
  if (stashes.length === 0) {
    Logger.info(`${TAG} no stashes to triage`);
    return { ok: true, actions: [], failures: [] };
  }
  for (const s of stashes) {
    Logger.info(`${TAG}   • ${s.ref} (${s.createdAt}) ${s.message}`);
  }
  if (opts.dryRun) {
    Logger.info(
      `${TAG} DRY RUN — ${stashes.length} stash(es) listed; no drops applied`,
    );
    return {
      ok: true,
      actions: stashes.map((s) => ({ ref: s.ref, action: 'keep' })),
      failures: [],
    };
  }
  const decideFn =
    opts.yes || opts.json
      ? buildAllowlistDecider(opts.dropStashes)
      : promptStashDecision;
  return executeStashes({ cwd, stashes, decideFn });
}

/* node:coverage ignore next */
async function main() {
  const opts = parseCleanupArgs(process.argv.slice(2));
  const cwd = path.resolve(opts.cwd ?? PROJECT_ROOT);
  const baseBranch = resolveBaseBranch(cwd, opts.base);

  let fastForward = null;
  let prune = null;
  let branchesPlan = null;
  let branchesResult = null;
  let stashes = null;

  if (opts.phases.fastForwardMain) {
    fastForward = await runFastForwardPhase(opts, cwd, baseBranch);
  }
  if (opts.phases.pruneRemotes) {
    prune = await runPrunePhase(opts, cwd);
  }
  if (opts.phases.branches) {
    const r = await runBranchPhase(opts, cwd, baseBranch);
    branchesPlan = r.plan;
    branchesResult = r.result;
  }
  if (opts.phases.stashes) {
    stashes = await runStashPhase(opts, cwd);
  }

  if (opts.json) {
    const envelope = buildJsonEnvelope({
      dryRun: opts.dryRun,
      baseBranch,
      plan: branchesPlan ?? { candidates: [], skipped: [] },
      result: branchesResult,
      fastForward,
      prune,
      stashes,
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  }

  process.exit(
    computeExitCode({
      branchesPlan,
      branchesResult,
      fastForward,
      prune,
      stashes,
    }),
  );
}

runAsCli(import.meta.url, main, { source: 'git-cleanup' });
