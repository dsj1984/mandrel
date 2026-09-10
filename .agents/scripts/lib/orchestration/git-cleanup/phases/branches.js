/**
 * branches.js — branch-reap phase of git-cleanup (Story #2466).
 * Owns `planCleanup` + `executeCleanup`. Reap helpers live in
 * `branches-reap.js`; the non-PR detection signals and the remote-only
 * walk live in `branches-detect.js`.
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
 * The detection signal the weak-signal guard withholds on, and the reason
 * it records (Story #5283). `content-merged` comes from
 * `git merge-tree --write-tree` finding the branch's changes already
 * present in the base by *some* route — it cannot tell a squash-merge
 * from a branch whose every change was independently reverted, so it is
 * the one signal an unattended `--yes` run must not delete a remote ref
 * on. Named here so the guard, the renderer and the tests share one
 * spelling.
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
 * Pure-ish: enumerate merged-branch candidates.
 *
 * The PR probe classifies each candidate by the **latest** PR on the head
 * ref rather than any historical merge. Branches whose latest PR is OPEN
 * or CLOSED-not-merged are skipped with `reason: 'latest-pr-open'` /
 * `reason: 'latest-pr-closed-not-merged'`. A MERGED PR whose `headRefOid`
 * differs from the branch tip is resolved by ancestry in
 * `merged-tip.js` — a tip *behind* the merged head becomes a candidate
 * carrying `behindMerge: true`, a tip *ahead* of it keeps the
 * `tip-diverged-from-merge` force-push skip, and an unresolvable rev
 * skips as `unverifiable`.
 *
 * Performance (Story #3333): when the caller does not inject its own
 * `prProbe`, the planner fires **one** bulk `gh pr list --state all`
 * (via {@link probeAllPrs}) up front and indexes the page by
 * `headRefName`. Each branch loop then reads its PR signal from that Map
 * instead of spawning a per-branch `gh`. {@link probeLatestPr} remains
 * the per-branch fallback for head refs absent from the bulk page (a PR
 * that fell outside the fetch window), so correctness is preserved for
 * every branch. Injecting `prProbe` bypasses the bulk fetch entirely.
 *
 * Story #4395 adds three refinements:
 *   - **Content-equivalence signal.** A local branch with no reapable PR
 *     verdict and no ancestry match gets one more chance via
 *     {@link probeContentEquivalent} (`git merge-tree --write-tree`):
 *     when merging it into `baseBranch` would be a content no-op, it is
 *     classified `detectedBy: 'content-merged'` instead of skipped.
 *   - **Fresh ancestry anchor.** The ancestry signal (`git branch --merged`)
 *     is unioned against `origin/<base>` (via `refExistsFn` + `mergedLister`)
 *     whenever that remote-tracking ref exists, so a stale local `<base>`
 *     no longer hides a branch already merged on the remote.
 *   - **Graceful `gh` degradation.** A throwing `gh` runner (auth failure,
 *     rate limit, missing binary) inside the bulk index fetch or the
 *     per-branch fallback is caught, logged once, and degrades to
 *     git-only signals (ancestry + content-equivalence) rather than
 *     aborting the whole plan. The returned envelope's `ghDegraded` flag
 *     records whether this happened.
 *
 * Story #5188 makes the **remote-only** walk total (it now lives in
 * `branches-detect.js`). It used to classify by
 * the latest-PR verdict alone and return early on a `no-pr` verdict,
 * recording neither a candidate nor a skip — so a remote ref no PR record
 * covered was absent from `candidates[]`, `skipped[]`, the rendered log
 * and the `--json` envelope alike. It now runs the same three-signal
 * cascade the local walk does (PR verdict → ancestry → content
 * -equivalence → `not-merged` skip), over its own remote-namespace
 * ancestry source and with every git probe handed the qualified
 * `<remote>/<branch>` rev. Every enumerated branch that passes the
 * protected and filter checks therefore lands in exactly one of the two
 * collections. Deletion is unchanged: a remote-only candidate still needs
 * `--remote`, whichever signal detected it.
 */
/**
 * Normalize whatever `prIndexFn` returned into the
 * `{ index, complete }` pair {@link probeAllPrs} emits (Story #5283).
 *
 * The seam is injectable, and a caller that hands back a bare `Map` —
 * every pre-#5283 double does — means "here is the page" without
 * claiming it was exhaustive. That reads as `complete: false`, which
 * keeps the per-branch fallback armed: the conservative direction, since
 * a wrongly-complete page suppresses a probe that would have found a
 * real PR.
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
    // Story #5283: a complete page listed every PR in the repo, so this
    // head ref demonstrably has none. Probing it per-branch spends a `gh`
    // spawn to be told the same thing — once per PR-less branch, which on
    // a checkout full of local scratch branches is the whole point of the
    // bulk fetch undone.
    if (complete) return null;
    try {
      return prFallback(branch, c);
    } catch (err) {
      onDegrade(err);
      return null;
    }
  };
}

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
 * ## Weak-signal guard (Story #5283)
 *
 * `skipWeakSignal` withholds the **remote** delete of any candidate
 * detected only by content-equivalence, recording it on `remote[]` as
 * `{ skipped: true, reason: 'weak-signal-needs-confirmation' }` instead
 * of issuing `git push --delete`. The branch-phase driver arms it on the
 * `--yes` path unless the operator passed `--include-content-merged`,
 * mirroring the stash phase's `--drop-stashes` allowlist: an unattended
 * run may not destroy a remote ref on the weakest merge signal without
 * being told to. The interactive path leaves it disarmed — the prompt
 * already names the weak-signal count and the operator answered it.
 *
 * Local deletion is deliberately untouched: a local ref is recoverable
 * from the remote, which is exactly what the guard preserves.
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
    deleteRemoteFn = (b, c, r) => deleteBranchRemote(b, { cwd: c, remote: r }),
    pruneRemoteFn = (c, r) => pruneRemoteTracking(c, r, parsePrunedRefs),
    recordPendingCleanupFn = recordPendingCleanup,
    remoteName = 'origin',
    skipWeakSignal = false,
    logger = Logger,
  } = ctx;
  // The remote name belongs to `executeCleanup`, not to the per-candidate
  // reap helper, so bind it here (Story #5283). The default deleter used
  // to drop it and let `deleteBranchRemote` fall back to `origin`, which
  // sent every `--remote` delete of an `upstream`-configured checkout at
  // the wrong remote. Binding — rather than closing over it — also hands
  // an injected deleter the same `(branch, cwd, remote)` triple the git
  // invocation is built from, so a test can see which remote was targeted.
  const boundDeleteRemote = (b, c) => deleteRemoteFn(b, c, remoteName);
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
  // Prune drops the tracking refs a remote *delete* left behind. A run
  // whose every remote candidate was withheld deleted nothing, so there
  // is nothing stale to prune and no reason to spend the fetch.
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
