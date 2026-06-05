/**
 * branches.js — branch-reap phase of git-cleanup (Story #2466).
 * Owns `planCleanup` + `executeCleanup`. Reap helpers live in
 * `branches-reap.js`.
 * @module lib/orchestration/git-cleanup/phases/branches
 */

import { dirname } from 'node:path';

import {
  deleteBranchLocal,
  deleteBranchRemote,
} from '../../../git-branch-cleanup.js';
import { Logger } from '../../../Logger.js';
import { recordPendingCleanup } from '../../../worktree/lifecycle/pending-cleanup.js';
import {
  buildPruneSummary,
  reapLocalRef,
  reapRemoteRef,
  reapWorktree,
} from './branches-reap.js';
import { computeProtectedReason } from './filters.js';
import {
  branchTipSha,
  classifyLatestPr,
  currentBranch as defaultCurrentBranch,
  listLocalBranches,
  listMergedBranches,
  listRemoteBranches,
  probeAllPrs,
  probeLatestPr,
  pruneRemoteTracking,
  readProtectedConfig,
  removeWorktree,
  worktreesByBranch,
} from './git-probes.js';
import { parsePrunedRefs } from './prune.js';

function skipEntryFromVerdict(branch, verdict) {
  const entry = { branch, reason: verdict.reason };
  if (verdict.prNumber != null) entry.prNumber = verdict.prNumber;
  if (verdict.tipSha) entry.tipSha = verdict.tipSha;
  if (verdict.mergedSha) entry.mergedSha = verdict.mergedSha;
  return entry;
}

function evaluateLocalBranch({
  branch,
  classify,
  filter,
  mergedByGit,
  prProbe,
  cwd,
  wtMap,
  remoteName,
  branchTipShaFn,
}) {
  const protectedReason = classify(branch);
  if (protectedReason) return { skip: { branch, reason: protectedReason } };
  if (!filter(branch)) return { skip: { branch, reason: 'filtered' } };
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
    return { skip: skipEntryFromVerdict(branch, verdict) };
  }
  let detectedBy = null;
  let resolvedPrInfo = null;
  if (verdict.kind === 'candidate') {
    detectedBy = 'gh';
    resolvedPrInfo = verdict.prInfo;
  } else if (mergedByGit.has(branch)) {
    detectedBy = 'git-merged';
  } else {
    return { skip: { branch, reason: 'not-merged' } };
  }
  const wt = wtMap.get(branch);
  return {
    candidate: {
      branch,
      prNumber: resolvedPrInfo?.number ?? null,
      mergedAt: resolvedPrInfo?.mergedAt ?? null,
      hasWorktree: !!wt,
      worktreePath: wt?.path ?? null,
      detectedBy,
      localExists: true,
    },
  };
}

function collectRemoteOnlyCandidates({
  remoteLister,
  remoteName,
  cwd,
  localSet,
  classify,
  filter,
  prProbe,
  branchTipShaFn,
  skipped,
}) {
  const out = [];
  for (const branch of remoteLister(cwd, remoteName)) {
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
      skipped.push(skipEntryFromVerdict(branch, verdict));
      continue;
    }
    out.push({
      branch,
      prNumber: verdict.prInfo.number ?? null,
      mergedAt: verdict.prInfo.mergedAt ?? null,
      hasWorktree: false,
      worktreePath: null,
      detectedBy: 'remote-only',
      localExists: false,
    });
  }
  return out;
}

/**
 * Pure-ish: enumerate merged-branch candidates.
 *
 * The PR probe classifies each candidate by the **latest** PR on the head
 * ref rather than any historical merge. Branches whose latest PR is OPEN
 * or CLOSED-not-merged are skipped with `reason: 'latest-pr-open'` /
 * `reason: 'latest-pr-closed-not-merged'`. When the latest PR is MERGED
 * but the branch tip has diverged from the PR's `headRefOid` (post-merge
 * force-push), the branch is skipped with
 * `reason: 'tip-diverged-from-merge'`.
 *
 * Performance (Story #3333): when the caller does not inject its own
 * `prProbe`, the planner fires **one** bulk `gh pr list --state all`
 * (via {@link probeAllPrs}) up front and indexes the page by
 * `headRefName`. Each branch loop then reads its PR signal from that Map
 * instead of spawning a per-branch `gh`. {@link probeLatestPr} remains
 * the per-branch fallback for head refs absent from the bulk page (a PR
 * that fell outside the fetch window), so correctness is preserved for
 * every branch. Injecting `prProbe` bypasses the bulk fetch entirely.
 */
export function planCleanup(ctx) {
  const {
    cwd,
    baseBranch,
    localLister = listLocalBranches,
    mergedLister = listMergedBranches,
    currentBranchFn = defaultCurrentBranch,
    protectedConfigFn = readProtectedConfig,
    worktreesFn = worktreesByBranch,
    prProbe: injectedPrProbe,
    prIndexFn = probeAllPrs,
    prFallback = probeLatestPr,
    branchTipShaFn = branchTipSha,
    filter = () => true,
    includeRemoteOnly = false,
    remoteLister = listRemoteBranches,
    remoteName = 'origin',
  } = ctx;
  const prProbe =
    injectedPrProbe ??
    (() => {
      const prIndex = prIndexFn(cwd);
      return (branch, c) =>
        prIndex.has(branch) ? prIndex.get(branch) : prFallback(branch, c);
    })();
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
    const out = evaluateLocalBranch({
      branch,
      classify,
      filter,
      mergedByGit,
      prProbe,
      cwd,
      wtMap,
      remoteName,
      branchTipShaFn,
    });
    if (out.skip) skipped.push(out.skip);
    else candidates.push(out.candidate);
  }
  if (includeRemoteOnly) {
    candidates.push(
      ...collectRemoteOnlyCandidates({
        remoteLister,
        remoteName,
        cwd,
        localSet,
        classify,
        filter,
        prProbe,
        branchTipShaFn,
        skipped,
      }),
    );
  }
  return { candidates, skipped };
}

/**
 * Derive the pending-cleanup manifest root from a candidate's worktree
 * path. The manifest lives in the worktree root (`.worktrees/`), and a
 * candidate's `worktreePath` is `<root>/story-<id>`, so the parent
 * directory is the root. Returns `null` when the candidate has no
 * worktree path (remote-only / no-worktree candidate).
 */
function worktreeRootFor(cand) {
  if (!cand.worktreePath) return null;
  return dirname(cand.worktreePath);
}

/**
 * Pure-ish: execute the branch reap plan.
 *
 * Ref-reap is decoupled from worktree-reap (Story #3598): every
 * already-merged candidate has its local ref (and remote ref, in
 * `--remote` mode) deleted regardless of whether its worktree directory
 * could be physically removed. A lock-class worktree-removal failure is
 * recorded as a non-fatal `deferred` entry + a `pending-cleanup` handoff
 * (drained by the next plan-time worktree-sweep) rather than a hard
 * `failure`, so an OS file lock on an already-merged branch's directory
 * never makes the run exit non-zero. A non-lock worktree failure still
 * surfaces as a hard failure.
 */
export function executeCleanup(ctx) {
  const {
    candidates,
    cwd,
    remote,
    removeWorktreeFn = removeWorktree,
    deleteLocalFn = (b, c) => deleteBranchLocal(b, { cwd: c, force: true }),
    deleteRemoteFn = (b, c) => deleteBranchRemote(b, { cwd: c }),
    pruneRemoteFn = (c, r) => pruneRemoteTracking(c, r, parsePrunedRefs),
    recordPendingCleanupFn = recordPendingCleanup,
    remoteName = 'origin',
    logger = Logger,
  } = ctx;
  const worktrees = [];
  const local = [];
  const remoteResults = [];
  const failures = [];
  const deferred = [];
  for (const cand of candidates) {
    // Worktree removal is attempted but its outcome does NOT gate the ref
    // reap: the candidate is already merged, so a leftover directory must
    // never strand the ref. Lock-class removal failures are deferred to
    // the pending-cleanup sweep inside reapWorktree.
    reapWorktree({
      cand,
      removeWorktreeFn,
      cwd,
      logger,
      worktrees,
      failures,
      deferred,
      recordPendingCleanupFn,
      worktreeRoot: worktreeRootFor(cand),
    });
    if (!reapLocalRef({ cand, deleteLocalFn, cwd, local, failures })) continue;
    if (remote)
      reapRemoteRef({ cand, deleteRemoteFn, cwd, remoteResults, failures });
  }
  let prune = null;
  if (remote && remoteResults.length > 0) {
    prune = buildPruneSummary({ pruneRemoteFn, cwd, remoteName, failures });
  }
  return {
    worktrees,
    local,
    remote: remoteResults,
    prune,
    failures,
    deferred,
    ok: failures.length === 0,
  };
}
