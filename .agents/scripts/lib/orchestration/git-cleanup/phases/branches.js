/**
 * Branch-reap phase of git-cleanup: `planCleanup` + `executeCleanup`.
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
  collectRemoteOnlyCandidates,
  evaluateContentEquivalence,
  skipEntryFromVerdict,
} from './branches-detect.js';
import {
  buildPruneSummary,
  reapLocalRef,
  reapRemoteRef,
  reapWorktree,
} from './branches-reap.js';
import { computeProtectedReason } from './filters.js';
import {
  branchLastCommitAt,
  branchTipSha,
  classifyLatestPr,
  currentBranch as defaultCurrentBranch,
  freshAnchoredMergedSet,
  listLocalBranches,
  listMergedBranches,
  listRemoteBranches,
  listRemoteMergedBranches,
  probeAllPrs,
  probeContentEquivalent,
  probeLatestPr,
  pruneRemoteTracking,
  readProtectedConfig,
  refExists,
  removeWorktree,
  worktreesByBranch,
} from './git-probes.js';
import { probeAncestry } from './merged-tip.js';
import { parsePrunedRefs } from './prune.js';

const TAG = '[git-cleanup]';

/**
 * `content-merged` cannot tell a squash-merge from independently reverted
 * changes, so an unattended `--yes` run must not delete a remote ref on it.
 */
const WEAK_SIGNAL_DETECTOR = 'content-merged';
const WEAK_SIGNAL_REASON = 'weak-signal-needs-confirmation';

function evaluateLocalBranch({
  branch,
  baseBranch,
  classify,
  filter,
  mergedByGit,
  prProbe,
  cwd,
  wtMap,
  remoteName,
  branchTipShaFn,
  ancestryFn,
  contentEquivalentFn,
  branchLastCommitFn,
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
    ancestryFn,
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
    const out = evaluateContentEquivalence({
      branch,
      baseBranch,
      cwd,
      contentEquivalentFn,
      branchLastCommitFn,
    });
    if (out.skip) return out;
    detectedBy = out.detectedBy;
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
      behindMerge: verdict.reason === 'tip-behind-merge',
    },
  };
}

/**
 * Normalize `prIndexFn`'s result to `{ index, complete }`. A bare `Map` reads
 * as incomplete, keeping the per-branch fallback armed (the safe direction).
 *
 * @param {unknown} value
 * @returns {{ index: Map, complete: boolean }}
 */
function normalizePrIndex(value) {
  if (value instanceof Map) return { index: value, complete: false };
  return {
    index: value?.index instanceof Map ? value.index : new Map(),
    complete: value?.complete === true,
  };
}

function buildGuardedPrProbe({ cwd, prIndexFn, prFallback, onDegrade }) {
  let bulk;
  try {
    bulk = normalizePrIndex(prIndexFn(cwd));
  } catch (err) {
    onDegrade(err);
    bulk = { index: new Map(), complete: false };
  }
  const { index: prIndex, complete } = bulk;
  return (branch, c) => {
    if (prIndex.has(branch)) return prIndex.get(branch);
    // A complete page proves this head ref has no PR; skip the `gh` spawn.
    if (complete) return null;
    try {
      return prFallback(branch, c);
    } catch (err) {
      onDegrade(err);
      return null;
    }
  };
}

/**
 * Enumerate merged-branch candidates. Signals cascade: latest PR on the head
 * ref (one bulk `gh` fetch, per-branch fallback) → ancestry against local and
 * `<remote>/<base>` → content-equivalence. A failing `gh` degrades once to
 * git-only signals (`ghDegraded`). Every enumerated branch lands in exactly
 * one of `candidates` / `skipped`.
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
    ancestryFn = probeAncestry,
    contentEquivalentFn = probeContentEquivalent,
    branchLastCommitFn = branchLastCommitAt,
    refExistsFn = refExists,
    filter = () => true,
    includeRemoteOnly = false,
    remoteLister = listRemoteBranches,
    remoteMergedLister = listRemoteMergedBranches,
    remoteName = 'origin',
    logger = Logger,
  } = ctx;
  let ghDegraded = false;
  const onDegrade = (err) => {
    if (ghDegraded) return;
    ghDegraded = true;
    logger.warn?.(
      `${TAG} ⚠️ gh probe failed (${err?.message ?? err}); continuing with git-only signals`,
    );
  };
  const prProbe =
    injectedPrProbe ??
    buildGuardedPrProbe({ cwd, prIndexFn, prFallback, onDegrade });
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
  const remoteBaseRef = `${remoteName}/${baseBranch}`;
  const mergedSetArgs = { cwd, baseBranch, remoteBaseRef, refExistsFn };
  const mergedByGit = freshAnchoredMergedSet({
    ...mergedSetArgs,
    lister: mergedLister,
  });
  const localBranches = localLister(cwd);
  const localSet = new Set(localBranches);
  const candidates = [];
  const skipped = [];
  for (const branch of localBranches) {
    const out = evaluateLocalBranch({
      branch,
      baseBranch,
      classify,
      filter,
      mergedByGit,
      prProbe,
      cwd,
      wtMap,
      remoteName,
      branchTipShaFn,
      ancestryFn,
      contentEquivalentFn,
      branchLastCommitFn,
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
        baseBranch,
        localSet,
        classify,
        filter,
        prProbe,
        branchTipShaFn,
        ancestryFn,
        mergedRemote: freshAnchoredMergedSet({
          ...mergedSetArgs,
          lister: remoteMergedLister,
          remoteName,
        }),
        contentEquivalentFn,
        branchLastCommitFn,
        skipped,
      }),
    );
  }
  return { candidates, skipped, ghDegraded };
}

/** Pending-cleanup manifest root: the worktree's parent dir, or `null`. */
function worktreeRootFor(cand) {
  if (!cand.worktreePath) return null;
  return dirname(cand.worktreePath);
}

/**
 * Execute the reap plan. `skipWeakSignal` (armed on unattended `--yes` runs)
 * withholds only the remote delete of `content-merged` candidates; the local
 * ref stays deletable because the remote preserves it. Ref reap never waits
 * on worktree removal: a lock-class removal failure is deferred to the
 * pending-cleanup sweep, not a hard failure.
 */
export function executeCleanup(ctx) {
  const {
    candidates,
    cwd,
    remote,
    removeWorktreeFn = removeWorktree,
    deleteLocalFn = (b, c) => deleteBranchLocal(b, { cwd: c, force: true }),
    deleteRemoteFn = (b, c, r) => deleteBranchRemote(b, { cwd: c, remote: r }),
    pruneRemoteFn = (c, r) => pruneRemoteTracking(c, r, parsePrunedRefs),
    recordPendingCleanupFn = recordPendingCleanup,
    remoteName = 'origin',
    skipWeakSignal = false,
    logger = Logger,
  } = ctx;
  // Bind the remote explicitly, or the deleter falls back to `origin`.
  const boundDeleteRemote = (b, c) => deleteRemoteFn(b, c, remoteName);
  const worktrees = [];
  const local = [];
  const remoteResults = [];
  const failures = [];
  const deferred = [];
  for (const cand of candidates) {
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
    if (!remote) continue;
    if (skipWeakSignal && cand.detectedBy === WEAK_SIGNAL_DETECTOR) {
      remoteResults.push({
        branch: cand.branch,
        ok: true,
        skipped: true,
        reason: WEAK_SIGNAL_REASON,
        alreadyGone: false,
        detectedBy: cand.detectedBy,
      });
      continue;
    }
    reapRemoteRef({
      cand,
      deleteRemoteFn: boundDeleteRemote,
      cwd,
      remoteResults,
      failures,
    });
  }
  let prune = null;
  // Prune only when some remote delete actually ran.
  if (remote && remoteResults.some((r) => !r.skipped)) {
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
