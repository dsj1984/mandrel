/**
 * The Story-scope review, overlapped with the close-validation gates: started
 * once the pre-gate self-heal commits land, pinned to that HEAD SHA, and held
 * (computed, never posted) until the PR exists. A pushed HEAD that differs
 * discards it for a serial review. The held promise never rejects, so an
 * abandoned review leaves no unhandled rejection.
 */

import { postReviewComment } from '../code-review.js';
import { upsertStructuredComment } from '../ticketing.js';
import {
  computeStoryScopeReview,
  runStoryScopeReview,
  settleStoryScopeReview,
} from './phases/code-review.js';

/** @typedef {{ sha: string, startedAtMs: number, settled: Promise<object> }} HeldReview */

/** @returns {string|null} the commit `storyBranch` points at. */
function resolveBranchSha({ cwd, storyBranch, gitSpawnFn }) {
  try {
    const probe = gitSpawnFn(
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      `${storyBranch}^{commit}`,
    );
    const sha = probe?.status === 0 ? String(probe.stdout ?? '').trim() : '';
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** @returns {HeldReview|null} null when the SHA is unresolvable. */
export function startHeldReview({
  cwd,
  storyId,
  storyBranch,
  baseBranch,
  provider,
  runCodeReviewFn,
  gitSpawnFn,
  progress,
  nowMs = Date.now,
}) {
  const sha = resolveBranchSha({ cwd, storyBranch, gitSpawnFn });
  if (!sha) {
    progress(
      'REVIEW',
      `⏭ Could not resolve ${storyBranch}; the Story-scope review runs after PR-open.`,
    );
    return null;
  }
  const startedAtMs = nowMs();
  const settled = computeStoryScopeReview({
    cwd,
    storyId,
    headRef: sha,
    baseBranch,
    deferPost: true,
    provider,
    runCodeReviewFn,
    gitSpawnFn,
    progress,
  }).then(
    (value) => ({ ok: true, value, endedAtMs: nowMs() }),
    (error) => ({ ok: false, error, endedAtMs: nowMs() }),
  );
  return { sha, startedAtMs, settled };
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
 * Post a held review of the pushed HEAD (phase untimed: it records its own
 * wall time), else run the serial review.
 *
 * @returns {Promise<object>} the review outcome.
 */
export async function reviewAfterPrOpen(args) {
  const { held, setPhase, progress } = args;
  if (held && args.prNumber != null) {
    const pushedSha = resolveBranchSha(args);
    if (pushedSha === held.sha) {
      setPhase('code-review');
      args.pauseTimer();
      progress(
        'REVIEW',
        `Posting the held Story-scope review of ${held.sha.slice(0, 12)} → PR #${args.prNumber}...`,
      );
      return await postHeldReview(held, args);
    }
    discardHeldReview(
      held,
      `pushed HEAD ${pushedSha ?? 'unresolved'} is not the reviewed ${held.sha}; re-running serially`,
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
