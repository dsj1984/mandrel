/**
 * phases/review-core.js — the shared Story-scope review spine; keeps the
 * maker-blind `runCodeReview` invocation out of any phase file.
 */

import { gitSpawn } from '../../../git-utils.js';
import { computeChangeSet } from '../../change-set.js';
import { runCodeReview } from '../../code-review.js';

/**
 * Run `runCodeReview` over one change set and return the review result.
 * Throws propagate; the caller picks the advisory posture. Review depth is
 * derived by `runCodeReview` from the changed files and is input-only — it
 * never alters the output envelope.
 *
 * The diff is enumerated exactly once here and injected into the review, so
 * review depth scores the same file set the change set names even if a
 * commit lands in between. An unenumerable diff injects `null` ("already
 * tried"), which the review honours without re-spawning git.
 *
 * @param {{
 *   storyId: number|string,
 *   baseRef: string,
 *   headRef: string,
 *   commentTargetId?: number|null,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 *   gitSpawnFn?: import('../../change-set.js').GitSpawnFn,
 *   computeChangeSetFn?: typeof computeChangeSet,
 *   runCodeReviewFn?: typeof runCodeReview,
 * }} args
 * @returns {Promise<object>} The `runCodeReview` result plus the computed
 *   `changeSet`.
 */
export async function runStoryReviewCore({
  storyId,
  baseRef,
  headRef,
  commentTargetId = null,
  provider,
  progress,
  progressTag = 'CODE-REVIEW',
  gitSpawnFn = gitSpawn,
  computeChangeSetFn = computeChangeSet,
  runCodeReviewFn = runCodeReview,
}) {
  const changeSet = computeChangeSetFn({ baseRef, headRef, gitSpawnFn });

  const opts = {
    scope: 'story',
    ticketId: Number(storyId),
    baseRef,
    headRef,
    provider,
    changedFiles: changeSet.files,
    gitSpawnFn,
    logger: {
      info: (m) => progress(progressTag, m),
      warn: (m) => progress(progressTag, `⚠️ ${m}`),
    },
  };
  if (commentTargetId != null) {
    opts.commentTargetId = commentTargetId;
  }

  const result = await runCodeReviewFn(opts);
  return { ...result, changeSet };
}
