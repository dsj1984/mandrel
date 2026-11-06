/**
 * The Story-scope review, overlapped with the close-validation gates: started
 * once the pre-gate self-heal commits land and held (computed, never posted)
 * until the PR exists. A deposit whose diff digest matches the diff at that
 * point **is** the held result, so nothing is computed. After PR-open a
 * pushed diff with a different digest discards it for a serial review of the
 * pushed SHA — a base-sync merge that moves only offsets keeps the digest.
 * Every non-degraded review close computes is deposited when it settles, so a
 * retry on the same diff adopts it. The held promise never rejects, so an
 * abandoned review leaves no unhandled rejection.
 */

import { postReviewComment } from '../code-review.js';
import {
  buildReviewDeposit,
  computeReviewDiffDigest,
  depositAsComputedReview,
  probeHeldReviewDiff,
  resolveRefSha,
  writeReviewDeposit,
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

/** A held result already in hand: the deposit. */
function adoptedSettlement(deposit, atMs) {
  const value = depositAsComputedReview(deposit);
  return Promise.resolve({ ok: true, value, endedAtMs: atMs });
}

/** Deposit a computed result; a failed write is a warning, never a failure. */
function depositReview(args, held, result) {
  if (!result || result.degraded || !held.diffDigest) return;
  const { writeDepositFn = writeReviewDeposit, progress } = args;
  try {
    const deposit = buildReviewDeposit({
      storyId: Number(args.storyId),
      headSha: held.sha,
      baseRef: held.baseRef,
      diffDigest: held.diffDigest,
      result,
    });
    writeDepositFn(deposit, { config: args.config });
  } catch (err) {
    progress(
      'REVIEW',
      `⚠️ Could not deposit the Story-scope review: ${err?.message ?? err}`,
    );
  }
}

/** Compute the review of `held.sha`, held unposted; never rejects. */
function computeHeldReview(args, held) {
  const { nowMs = Date.now } = args;
  return computeStoryScopeReview({
    ...args,
    headRef: held.sha,
    deferPost: true,
  }).then(
    (value) => {
      const endedAtMs = nowMs();
      depositReview(args, held, value.result);
      return { ok: true, value, endedAtMs };
    },
    (error) => ({ ok: false, error, endedAtMs: nowMs() }),
  );
}

/** Adopt the matching deposit for `sha`, else compute (and deposit) it. */
function holdReview(args, sha) {
  const { progress, nowMs = Date.now } = args;
  const { baseRef, diffDigest, deposit } = probeHeldReviewDiff({
    ...args,
    sha,
  });
  const startedAtMs = nowMs();
  const held = { sha, baseRef, diffDigest, adopted: !!deposit, startedAtMs };
  if (deposit) {
    progress('REVIEW', `♻️ Adopting the deposited review; none computed.`);
    return { ...held, settled: adoptedSettlement(deposit, startedAtMs) };
  }
  return { ...held, settled: computeHeldReview(args, held) };
}

/**
 * @param {{ cwd: string, storyId: number, storyBranch: string,
 *   baseBranch: string, provider: object, runCodeReviewFn: Function,
 *   gitSpawnFn: Function, progress: Function, config?: object,
 *   readDepositFn?: Function, writeDepositFn?: Function,
 *   nowMs?: () => number }} args
 * @returns {HeldReview|null} null when the SHA is unresolvable.
 */
export function startHeldReview(args) {
  const { cwd, storyBranch, gitSpawnFn, progress } = args;
  const sha = resolveBranchSha({ cwd, storyBranch, gitSpawnFn });
  if (!sha) {
    progress(
      'REVIEW',
      `⏭ Could not resolve ${storyBranch}; the Story-scope review runs after PR-open.`,
    );
    return null;
  }
  return holdReview(args, sha);
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
 * Post a held review whose diff digest matches the pushed diff, else review
 * the pushed SHA serially (deposited before it posts). Either phase is
 * untimed: the review records its own wall time.
 *
 * @returns {Promise<object>} the review outcome.
 */
export async function reviewAfterPrOpen(args) {
  const { held, setPhase, progress } = args;
  const sha = resolveBranchSha(args);
  if (held && args.prNumber != null) {
    const pushedDigest = computeReviewDiffDigest({
      cwd: args.cwd,
      baseRef: held.baseRef,
      headRef: sha,
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
  if (args.prNumber != null && sha) {
    args.pauseTimer();
    return await postHeldReview(holdReview(args, sha), args);
  }
  return await runStoryScopeReview(args);
}
