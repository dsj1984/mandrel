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
 * (exported from `story-close/phases/review-core.js`) so the close path
 * shares a single invocation pattern (Story #3653). Review depth needs no
 * input here: it is derived from this Story's own diff inside `runCodeReview`
 * (Story #4542).
 *
 * Story #5325 — this phase boundary is where the base ref is resolved, once.
 * The resolved ref threads into `runStoryReviewCore`, which hands it to both
 * the change-set enumeration (and through it the provider review) and the
 * local lens pass, so one resolution corrects both arms. It resolves to
 * `origin/<baseBranch>` — the ref base-sync merged from — rather than the bare
 * branch name git would resolve to the local `refs/heads/<baseBranch>`, whose
 * drift would otherwise be scored as this Story's own change.
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
  runLocalLensReviewFn,
  appendFindingsYieldFn,
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
 * Run the Story-scope code review against `main`, post the structured
 * findings comment to the PR, and add a one-line cross-reference comment
 * on the Story issue linking back to the PR review comment.
 *
 * Failure modes:
 *   - When `prNumber` is null (couldn't parse), the review is skipped
 *     and the function returns `{ halted: false, skipped: true }`.
 *   - When `origin/<baseBranch>` cannot be resolved, the review is skipped,
 *     a `base-ref-resolution` degradation is recorded on the returned
 *     envelope, and no findings are raised (Story #5325).
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
 *   localLensReview?: object,
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
  runLocalLensReviewFn,
  appendFindingsYieldFn,
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

  // One resolution per close, at the phase boundary: `baseRef` threads from
  // here into the change set, the provider review and the local lens pass.
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
    runLocalLensReviewFn,
    appendFindingsYieldFn,
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
    localLensReview: result.localLensReview,
  };
}
