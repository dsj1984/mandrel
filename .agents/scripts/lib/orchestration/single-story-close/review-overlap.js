/**
 * review-overlap.js — the Story-scope review, overlapped with the
 * close-validation gates.
 *
 * The review's diff is fixed only once the pre-gate self-heal steps have
 * committed, so {@link startHeldReview} runs there, pinned to the Story
 * branch's HEAD SHA at that moment. It computes and renders but posts
 * nothing: there is no PR yet. After PR-open, {@link reviewAfterPrOpen}
 * posts the held report — or, when the pushed HEAD is no longer the reviewed
 * SHA, discards it and reviews serially, so findings never post for a tree
 * other than the one pushed.
 *
 * The held promise never rejects: a review that throws is carried as a
 * settled failure and re-thrown at the code-review phase, so a validation
 * failure that ends the close first leaves no unhandled rejection. The review
 * is provider/API-bound; it neither takes the full-suite lock nor spawns the
 * test suite.
 */

import { postReviewComment } from '../code-review.js';
import { upsertStructuredComment } from '../ticketing.js';
import {
  computeStoryScopeReview,
  runStoryScopeReview,
  settleStoryScopeReview,
} from './phases/code-review.js';

/**
 * @typedef {{
 *   sha: string,
 *   startedAtMs: number,
 *   settled: Promise<{ ok: true, value: object, endedAtMs: number }
 *     | { ok: false, error: unknown, endedAtMs: number }>,
 * }} HeldReview
 */

/**
 * The commit `storyBranch` points at, or `null` when it cannot be resolved.
 *
 * @param {{ cwd: string, storyBranch: string, gitSpawnFn: Function }} args
 * @returns {string|null}
 */
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

/**
 * Start the review against the Story branch's current HEAD SHA, posting
 * nothing. Returns `null` (the serial review then runs after PR-open) when
 * that SHA cannot be resolved.
 *
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   storyBranch: string,
 *   baseBranch: string,
 *   provider: object,
 *   runCodeReviewFn: Function,
 *   gitSpawnFn: Function,
 *   progress: (tag: string, msg: string) => void,
 *   nowMs?: () => number,
 * }} args
 * @returns {HeldReview|null}
 */
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

/**
 * Drop a held review without posting it. Its promise never rejects, so
 * abandoning it is safe.
 *
 * @param {HeldReview|null|undefined} held
 * @param {string} reason
 * @param {(tag: string, msg: string) => void} progress
 * @returns {void}
 */
export function discardHeldReview(held, reason, progress) {
  if (!held) return;
  progress('REVIEW', `🗑  Held Story-scope review discarded (${reason}).`);
}

/**
 * Await the held review, post it to the PR, and record its own wall time:
 * computation plus posting, never the idle gap between them.
 *
 * @param {HeldReview} held
 * @param {object} args
 * @returns {Promise<object>} the review outcome.
 */
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
 * The review after PR-open. A held review for the pushed HEAD is posted
 * (its phase untimed: the review records its own wall time); anything else
 * runs the serial review, timed as the `code-review` phase.
 *
 * @param {{
 *   held: HeldReview|null|undefined,
 *   cwd: string,
 *   storyId: number,
 *   storyBranch: string,
 *   baseBranch: string,
 *   prUrl: string,
 *   prNumber: number|null,
 *   provider: object,
 *   runCodeReviewFn: Function,
 *   gitSpawnFn: Function,
 *   progress: (tag: string, msg: string) => void,
 *   setPhase: (phase: string, opts?: { timed?: boolean }) => void,
 *   recordDuration: (phase: string, ms: number) => void,
 *   postReportFn?: typeof postReviewComment,
 *   nowMs?: () => number,
 * }} args
 * @returns {Promise<object>} the review outcome.
 */
export async function reviewAfterPrOpen(args) {
  const { held, setPhase, progress } = args;
  if (held && args.prNumber != null) {
    const pushedSha = resolveBranchSha(args);
    if (pushedSha === held.sha) {
      setPhase('code-review', { timed: false });
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
