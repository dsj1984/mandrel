/**
 * phases/review-core.js — the shared Story-scope review spine.
 *
 * Extracted from `phases/code-review.js` (Story #4603). `runStoryReviewCore` is
 * the one implementation both close paths call `runCodeReview` through — the
 * epic-attached phase (`code-review.js#runStoryCodeReview`) and the standalone
 * v2 path (`single-story-close/phases/code-review.js#runStoryScopeReview`) —
 * so it belongs to neither and lives here rather than inside one path's phase
 * file (Story #3653 established the shared-spine contract).
 */

import { gitSpawn } from '../../../git-utils.js';
import { computeChangeSet } from '../../change-set.js';
import { runCodeReview } from '../../code-review.js';
import { runLocalLensReview } from './local-lens-review.js';

/**
 * Invoke `runCodeReviewFn` with the canonical Story-scope envelope and return
 * the raw result.
 *
 * The caller is responsible for error handling and result interpretation —
 * this function propagates throws rather than swallowing them, because the
 * two callers have different advisory postures:
 *
 *   - Epic-attached close: swallows throws (non-blocking advisory, same as
 *     `refresh.js`).
 *   - Standalone close: propagates throws (a review failure stops the close).
 *
 * Review depth is not passed in: `runCodeReview` derives it from the changed
 * files — their sensitive-path intersection plus their count (Story #4542, which
 * retired the planner-authored risk envelope this spine used to forward). Depth
 * remains an **input-only** signal: it tells the provider how thorough to be and
 * never alters the review's output envelope or the posted structured-comment
 * body.
 *
 * Story #4593 — this spine is the **single injection point** for the change set.
 * It enumerates `baseRef...headRef` exactly once via {@link computeChangeSet}
 * and threads the resulting list into both the local-lens pass and
 * `runCodeReview`, which otherwise each enumerated the diff for themselves. Both
 * consumers ultimately route through `deriveChangeLevel`, so feeding them one
 * list is what makes the lens roster and the review depth provably agree about
 * what changed — even when a commit lands between the two calls.
 *
 * Story #4603 — the invariant now holds on the failure path too: an unenumerable
 * diff injects an explicit `null`, and both consumers distinguish that from
 * `undefined` ("nobody enumerated") rather than re-spawning git.
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
 *   runLocalLensReviewFn?: typeof runLocalLensReview,
 * }} args
 * @returns {Promise<object>} Raw result envelope from `runCodeReview`, augmented
 *   with a `localLensReview` field carrying the Story-scope local-lens pass
 *   outcome (Epic #4405, Story #4409) and the `changeSet` this run computed
 *   (Story #4593).
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
  runLocalLensReviewFn = runLocalLensReview,
}) {
  const storyIdNum = Number(storyId);

  // The one enumeration per close run. Every consumer below is injected from
  // this list; none of them re-derives the diff. `files` is `null` when the
  // diff is unenumerable — an explicit "already tried" signal both consumers
  // honour without retrying (Story #4603).
  const changeSet = computeChangeSetFn({ baseRef, headRef, gitSpawnFn });

  const opts = {
    scope: 'story',
    ticketId: storyIdNum,
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

  // Shift-left local-lens pass (Epic #4405). Runs matched local lenses at
  // `light` depth against the actual Story diff, inside this close-subprocess
  // spine so the maker never grades its own work. Advisory — it never blocks
  // the close and its outcome rides on the returned envelope for downstream
  // consumers.
  const localLensReview = await runLocalLensReviewFn({
    baseRef,
    headRef,
    changedFiles: changeSet.files,
    storyId: storyIdNum,
    progress,
    progressTag,
    gitSpawnFn,
  });

  const result = await runCodeReviewFn(opts);
  return { ...result, localLensReview, changeSet };
}
