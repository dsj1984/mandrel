/**
 * The Story-scope review, overlapped with the close-validation gates: started
 * once the pre-gate self-heal commits land and held (computed, never posted)
 * until the PR exists. A worker deposit whose diff digest matches the diff at
 * that point **is** the held result, so nothing is computed. After PR-open a
 * pushed diff with a different digest discards it for a serial review — a
 * clean base-sync merge moves HEAD without changing the digest. The held
 * promise never rejects, so an abandoned review leaves no unhandled rejection.
 */

import { postReviewComment } from '../code-review.js';
import {
  computeReviewDiffDigest,
  depositAsComputedReview,
  probeHeldReviewDiff,
  resolveRefSha,
} from '../review-deposit.js';
import { upsertStructuredComment } from '../ticketing.js';
import {
  computeStoryScopeReview,
  runStoryScopeReview,
  settleStoryScopeReview,
} from './phases/code-review.js';

/** @typedef {{ sha: string, baseRef: string|null, diffDigest: string|null, adopted: boolean, startedAtMs: number, settled: Promise<object> }} HeldReview */

/** @returns {string|null} the commit `storyBranch` points at. */
function resolveBranchSha({ cwd, storyBranch, gitSpawnFn }) {
  return resolveRefSha({ cwd, ref: storyBranch, gitSpawnFn });
}

/** A held result already in hand: the worker deposit. */
function adoptedSettlement(deposit, atMs) {
  const value = depositAsComputedReview(deposit);
  return Promise.resolve({ ok: true, value, endedAtMs: atMs });
}

/** Compute the review of `sha`, held unposted; never rejects. */
function computeHeldReview({ sha, nowMs, ...args }) {
  return computeStoryScopeReview({
    ...args,
    headRef: sha,
    deferPost: true,
  }).then(
    (value) => ({ ok: true, value, endedAtMs: nowMs() }),
    (error) => ({ ok: false, error, endedAtMs: nowMs() }),
  );
}

/**
 * @param {{ cwd: string, storyId: number, storyBranch: string,
 *   baseBranch: string, provider: object, runCodeReviewFn: Function,
 *   gitSpawnFn: Function, progress: Function, config?: object,
 *   readDepositFn?: Function, nowMs?: () => number }} args
 * @returns {HeldReview|null} null when the SHA is unresolvable.
 */
export function startHeldReview(args) {
  const { cwd, storyBranch, gitSpawnFn, progress, nowMs = Date.now } = args;
  const sha = resolveBranchSha({ cwd, storyBranch, gitSpawnFn });
  if (!sha) {
    progress(
      'REVIEW',
      `⏭ Could not resolve ${storyBranch}; the Story-scope review runs after PR-open.`,
    );
    return null;
  }
  const { baseRef, diffDigest, deposit } = probeHeldReviewDiff({
    ...args,
    sha,
  });
  const startedAtMs = nowMs();
  const held = { sha, baseRef, diffDigest, adopted: !!deposit, startedAtMs };
  if (deposit) {
    progress('REVIEW', `♻️ Adopting the worker's held review; none computed.`);
    return { ...held, settled: adoptedSettlement(deposit, startedAtMs) };
  }
  const settled = computeHeldReview({ ...args, sha, nowMs });
  return { ...held, settled };
}

/** Drop a held review unposted. */
export function discardHeldReview(held, reason, progress) {
  if (!held) return;
  progress('REVIEW', `🗑  Held Story-scope review discarded (${reason}).`);
}

/** Post the held review; records compute + post time, never the idle gap. */
async function postHeldReview(held, args) {
  const { recordDuration, nowMs = Date.now, postReportFn } = args;
  const settledReview = await held.settled;
  const computeMs = settledReview.endedAtMs - held.startedAtMs;
  if (!settledReview.ok) {
    recordDuration('code-review', computeMs);
    throw settledReview.error;
  }
  const postStartedAtMs = nowMs();
  try {
    return await settleStoryScopeReview({
      computed: settledReview.value,
      storyId: args.storyId,
      prUrl: args.prUrl,
      prNumber: args.prNumber,
      provider: args.provider,
      progress: args.progress,
      postReportFn:
        postReportFn ??
        ((post) =>
          postReviewComment({
            ...post,
            upsertCommentFn: upsertStructuredComment,
          })),
    });
  } finally {
    recordDuration('code-review', computeMs + (nowMs() - postStartedAtMs));
  }
}

/**
 * Post a held review whose diff digest matches the pushed diff (phase
 * untimed: it records its own wall time), else run the serial review.
 *
 * @returns {Promise<object>} the review outcome.
 */
export async function reviewAfterPrOpen(args) {
  const { held, setPhase, progress } = args;
  if (held && args.prNumber != null) {
    const pushedDigest = computeReviewDiffDigest({
      cwd: args.cwd,
      baseRef: held.baseRef,
      headRef: resolveBranchSha(args),
      gitSpawnFn: args.gitSpawnFn,
    });
    if (pushedDigest !== null && pushedDigest === held.diffDigest) {
      setPhase('code-review');
      args.pauseTimer();
      progress(
        'REVIEW',
        `Posting the held Story-scope review → PR #${args.prNumber}...`,
      );
      return await postHeldReview(held, args);
    }
    discardHeldReview(
      held,
      'the pushed diff is not the reviewed diff; re-running serially',
      progress,
    );
  }
  setPhase('code-review');
  return await runStoryScopeReview({
    cwd: args.cwd,
    storyId: args.storyId,
    storyBranch: args.storyBranch,
    baseBranch: args.baseBranch,
    prUrl: args.prUrl,
    prNumber: args.prNumber,
    provider: args.provider,
    runCodeReviewFn: args.runCodeReviewFn,
    gitSpawnFn: args.gitSpawnFn,
    progress,
  });
}
