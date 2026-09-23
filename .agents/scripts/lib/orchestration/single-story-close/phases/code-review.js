/**
 * phases/code-review.js — Story-scope code review: findings post to the PR,
 * with a cross-reference on the Story issue. Critical findings return
 * `halted: true` so the caller never arms auto-merge.
 *
 * The base ref is resolved once, here, to `origin/<baseBranch>` (what
 * base-sync merged from) — the local branch's drift would otherwise be
 * scored as this Story's change.
 */

import { parsePrNumberFromUrl } from '../../../github-url.js';
import {
  resolveSharedBaseRef,
  unresolvedBaseReviewOutcome,
} from '../../review-base-ref.js';
import { degradationEnvelope } from '../../review-providers/degraded-gates.js';
import { runStoryReviewCore } from '../../story-close/phases/review-core.js';
import { postStructuredComment } from '../../ticketing/state.js';
import {
  buildOutcomeTally,
  formatReviewOutcomeLines,
} from './review-outcome.js';

/**
 * @param {string|null|undefined} prUrl
 * @returns {number|null}
 */
export const parsePrNumber = parsePrNumberFromUrl;

/**
 * @param {{
 *   prUrl: string,
 *   prNumber: number,
 *   commentUrl: string,
 *   severity: { critical: number, high: number, medium: number, suggestion: number },
 * }} args
 * @returns {string}
 */
export function buildStoryReviewCrossRefBody({
  prUrl,
  prNumber,
  commentUrl,
  severity,
  degradations,
}) {
  return (
    `🔬 Story-scope code review posted on PR [#${prNumber}](${prUrl}): ` +
    `[view findings](${commentUrl}) — ${buildOutcomeTally({ severity, degradations })}.`
  );
}

async function invokeStoryReviewCore({
  storyId,
  storyBranch,
  baseRef,
  prNumber,
  provider,
  runCodeReviewFn,
  gitSpawnFn,
  progress,
}) {
  return runStoryReviewCore({
    storyId,
    baseRef,
    headRef: storyBranch,
    commentTargetId: prNumber,
    provider,
    progress,
    progressTag: 'REVIEW',
    runCodeReviewFn,
    gitSpawnFn,
  });
}

async function postStoryReviewCrossRef({
  provider,
  storyId,
  prUrl,
  prNumber,
  result,
  severity,
  progress,
}) {
  if (result.posted && Number.isInteger(result.postedCommentId)) {
    const commentUrl = `${prUrl}#issuecomment-${result.postedCommentId}`;
    const body = buildStoryReviewCrossRefBody({
      prUrl,
      prNumber,
      commentUrl,
      severity,
      degradations: result.degradations,
    });
    try {
      await postStructuredComment(provider, storyId, 'notification', body);
      progress(
        'REVIEW',
        `📝 Cross-reference comment posted on Story #${storyId} → ${commentUrl}`,
      );
      return true;
    } catch (err) {
      progress(
        'REVIEW',
        `⚠️ Failed to post Story cross-reference comment: ${err?.message ?? err}`,
      );
      return false;
    }
  }
  if (!result.posted) {
    progress(
      'REVIEW',
      '⚠️ Skipping Story cross-reference comment: PR-side review comment did not post.',
    );
  }
  return false;
}

/**
 * Skips on an unparseable PR number or an unresolvable base (recording a
 * degradation); a runner throw propagates and fails the close.
 *
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   storyBranch: string,
 *   baseBranch: string,
 *   prUrl: string,
 *   prNumber: number|null,
 *   provider: object,
 *   runCodeReviewFn: Function,
 *   gitSpawnFn?: Function,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<{
 *   halted: boolean,
 *   skipped?: boolean,
 *   severity?: { critical: number, high: number, medium: number, suggestion: number },
 *   posted?: boolean,
 *   postedCommentId?: number|null,
 *   degraded?: boolean,
 *   degradations?: Array<object>,
 *   crossRefPosted?: boolean,
 * }>}
 */
export async function runStoryScopeReview({
  cwd,
  storyId,
  storyBranch,
  baseBranch,
  prUrl,
  prNumber,
  provider,
  runCodeReviewFn,
  gitSpawnFn,
  progress,
}) {
  if (prNumber == null) {
    progress(
      'REVIEW',
      `⏭ Story-scope review skipped: could not parse PR number from URL ${prUrl}.`,
    );
    return { halted: false, skipped: true };
  }

  const base = resolveSharedBaseRef({ baseBranch, cwd, gitSpawnFn });
  if (!base.resolved) {
    return unresolvedBaseReviewOutcome({
      storyId,
      baseBranch,
      remoteRef: base.remoteRef,
      progress,
    });
  }

  progress(
    'REVIEW',
    `Running Story-scope code review for Story #${storyId} (${base.ref}...${storyBranch}) → PR #${prNumber}...`,
  );

  const result = await invokeStoryReviewCore({
    storyId,
    storyBranch,
    baseRef: base.ref,
    prNumber,
    provider,
    runCodeReviewFn,
    gitSpawnFn,
    progress,
  });

  const sev = result.severity ?? {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  };
  const outcome = formatReviewOutcomeLines({
    severity: sev,
    degradations: result.degradations,
    prNumber,
    posted: result.posted,
  });
  for (const line of outcome) progress('REVIEW', line);

  const crossRefPosted = await postStoryReviewCrossRef({
    provider,
    storyId,
    prUrl,
    prNumber,
    result,
    severity: sev,
    progress,
  });

  return {
    halted: !!result.halted,
    severity: sev,
    posted: result.posted,
    postedCommentId: result.postedCommentId ?? null,
    ...degradationEnvelope(result.degradations),
    crossRefPosted,
  };
}
