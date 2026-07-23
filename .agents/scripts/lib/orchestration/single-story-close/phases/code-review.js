/**
 * phases/code-review.js — Story-scope code review phase for
 * `single-story-close`.
 *
 * Runs the Story-scope code review against `main`, posts the structured
 * findings comment to the PR (not the Story issue), and adds a one-line
 * cross-reference comment on the Story issue linking back to the PR
 * review comment. The render header still labels the comment "Story #N"
 * even though the post target is the PR — the PR is the comment surface,
 * the Story is the ticket the findings *describe*.
 *
 * Cross-reference URL shape: GitHub serves issue comments at
 * `<prUrl>#issuecomment-<commentId>` — the same URL pattern for PR
 * conversation comments and issue comments, because PRs are issues at
 * the API level.
 *
 * Re-exports `parsePrNumber` (delegates to `lib/github-url.js`) so
 * existing call sites need not change. Story #3649.
 *
 * Critical findings cause `runStoryScopeReview` to return `halted: true`;
 * the caller raises that to a thrown error so auto-merge is not enabled.
 *
 * Delegates the `runCodeReview` invocation to `runStoryReviewCore`
 * (exported from `story-close/phases/code-review.js`) so the close path
 * shares a single invocation pattern (Story #3653). Review depth needs no
 * input here: it is derived from this Story's own diff inside `runCodeReview`
 * (Story #4542).
 */

import { parsePrNumberFromUrl } from '../../../github-url.js';
import { runStoryReviewCore } from '../../story-close/phases/review-core.js';
import { postStructuredComment } from '../../ticketing/state.js';

/**
 * Extract the numeric PR ID from a `gh pr create` URL. The CLI returns a
 * URL like `https://github.com/<owner>/<repo>/pull/<n>`; we want `<n>`.
 * Returns `null` when the URL doesn't match. Exported for testing.
 *
 * Delegates to `parsePrNumberFromUrl` in `lib/github-url.js`.
 * Re-exported under the original name so existing call sites and tests
 * do not need to change. Story #3649.
 *
 * @param {string|null|undefined} prUrl
 * @returns {number|null}
 */
export const parsePrNumber = parsePrNumberFromUrl;

/**
 * Build the cross-reference comment body posted on the Story issue when
 * the PR-side review comment lands. Pure; exported for testing.
 *
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
}) {
  const tally =
    `critical:${severity.critical} · high:${severity.high} · ` +
    `medium:${severity.medium} · suggestion:${severity.suggestion}`;
  return (
    `🔬 Story-scope code review posted on PR [#${prNumber}](${prUrl}): ` +
    `[view findings](${commentUrl}) — ${tally}.`
  );
}

async function invokeStoryReviewCore({
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  provider,
  runCodeReviewFn,
  runLocalLensReviewFn,
  appendFindingsYieldFn,
  progress,
}) {
  return runStoryReviewCore({
    storyId,
    baseRef: baseBranch,
    headRef: storyBranch,
    commentTargetId: prNumber,
    provider,
    progress,
    progressTag: 'REVIEW',
    runCodeReviewFn,
    // Forward the seams only when the caller injects them; otherwise
    // `runStoryReviewCore` uses its defaults. `undefined` deep-merges to
    // the default via the destructuring default there.
    ...(runLocalLensReviewFn ? { runLocalLensReviewFn } : {}),
    ...(appendFindingsYieldFn ? { appendFindingsYieldFn } : {}),
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
 * Run the Story-scope code review against `main`, post the structured
 * findings comment to the PR, and add a one-line cross-reference comment
 * on the Story issue linking back to the PR review comment.
 *
 * Failure modes:
 *   - When `prNumber` is null (couldn't parse), the review is skipped
 *     and the function returns `{ halted: false, skipped: true }`.
 *   - When the runner throws, the close fails non-zero (the throw
 *     propagates) — a Story-scope review failure is not silently
 *     ignored.
 *
 * Exported for testing.
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
 *   runLocalLensReviewFn?: Function,
 *   appendFindingsYieldFn?: Function,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<{
 *   halted: boolean,
 *   skipped?: boolean,
 *   severity?: { critical: number, high: number, medium: number, suggestion: number },
 *   posted?: boolean,
 *   postedCommentId?: number|null,
 *   crossRefPosted?: boolean,
 *   localLensReview?: object,
 * }>}
 */
export async function runStoryScopeReview({
  cwd: _cwd,
  storyId,
  storyBranch,
  baseBranch,
  prUrl,
  prNumber,
  provider,
  runCodeReviewFn,
  runLocalLensReviewFn,
  appendFindingsYieldFn,
  progress,
}) {
  if (prNumber == null) {
    progress(
      'REVIEW',
      `⏭ Story-scope review skipped: could not parse PR number from URL ${prUrl}.`,
    );
    return { halted: false, skipped: true };
  }

  progress(
    'REVIEW',
    `Running Story-scope code review for Story #${storyId} (${baseBranch}...${storyBranch}) → PR #${prNumber}...`,
  );

  const result = await invokeStoryReviewCore({
    storyId,
    storyBranch,
    baseBranch,
    prNumber,
    provider,
    runCodeReviewFn,
    runLocalLensReviewFn,
    appendFindingsYieldFn,
    progress,
  });

  const sev = result.severity ?? {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  };
  progress(
    'REVIEW',
    `Findings — critical:${sev.critical} high:${sev.high} medium:${sev.medium} suggestion:${sev.suggestion}. Posted to PR #${prNumber}: ${result.posted}.`,
  );

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
    crossRefPosted,
    localLensReview: result.localLensReview,
  };
}
