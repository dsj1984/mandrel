/**
 * phases/review-core.js — the shared Story-scope review spine; keeps the
 * maker-blind `runCodeReview` invocation out of any phase file.
 */

import { countChangedLines } from '../../../audit-suite/index.js';
import { gitSpawn } from '../../../git-utils.js';
import { appendFindingsYield } from '../../../observability/metrics-ledger.js';
import { computeChangeSet } from '../../change-set.js';
import { runCodeReview } from '../../code-review.js';
import { runLocalLensReview } from './local-lens-review.js';

/**
 * Run the local-lens pass and `runCodeReview` over one change set and return
 * the review result. Throws propagate; the caller picks the advisory posture.
 * Review depth is derived by `runCodeReview` from the changed files and is
 * input-only — it never alters the output envelope.
 *
 * The diff is enumerated exactly once here and injected into both consumers,
 * so lens roster and review depth agree on what changed even if a commit
 * lands in between. An unenumerable diff injects `null` ("already tried"),
 * which both consumers honour without re-spawning git.
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
 *   countChangedLinesFn?: typeof countChangedLines,
 *   appendFindingsYieldFn?: typeof appendFindingsYield,
 * }} args
 * @returns {Promise<object>} The `runCodeReview` result plus
 *   `localLensReview` and the computed `changeSet`.
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
  countChangedLinesFn = countChangedLines,
  appendFindingsYieldFn = appendFindingsYield,
}) {
  const storyIdNum = Number(storyId);

  const changeSet = computeChangeSetFn({ baseRef, headRef, gitSpawnFn });

  // Line count for the lens diff-floor, probed only for a non-empty file set;
  // `null` = unknown, and the floor fails open.
  const changedLineCount =
    Array.isArray(changeSet.files) && changeSet.files.length > 0
      ? countChangedLinesFn({ baseRef, headRef, gitSpawnFn })
      : null;

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

  const localLensReview = await runLocalLensReviewFn({
    baseRef,
    headRef,
    changedFiles: changeSet.files,
    changedLineCount,
    storyId: storyIdNum,
    progress,
    progressTag,
    gitSpawnFn,
  });

  const result = await runCodeReviewFn(opts);

  // Best-effort findings-yield ledger, for tuning the roster on measurement.
  try {
    const yieldEntries = buildLensYieldEntries(localLensReview);
    if (yieldEntries !== null) {
      await appendFindingsYieldFn({
        storyId: storyIdNum,
        cli: 'story-close-review',
        lenses: yieldEntries,
        diffFloor: localLensReview?.floorSkip ?? null,
      });
    }
  } catch (err) {
    progress(
      progressTag,
      `⚠️ findings-yield ledger append failed (continuing): ${err?.message ?? err}`,
    );
  }

  return { ...result, localLensReview, changeSet };
}

/**
 * One findings-yield entry per matched lens; `null` for an empty roster.
 *
 * @param {object|null|undefined} localLensReview
 * @returns {Array<{ lens: string, findings: number, skippedByFloor: boolean }>|null}
 */
function buildLensYieldEntries(localLensReview) {
  const lenses = Array.isArray(localLensReview?.lenses)
    ? localLensReview.lenses.filter((l) => typeof l === 'string' && l.length)
    : [];
  if (lenses.length === 0) return null;
  const skippedByFloor = localLensReview?.floorSkip?.skip === true;
  const findingsByLens = new Map();
  for (const finding of localLensReview?.materialized?.findings ?? []) {
    if (typeof finding?.audit !== 'string') continue;
    findingsByLens.set(
      finding.audit,
      (findingsByLens.get(finding.audit) ?? 0) + 1,
    );
  }
  return lenses.map((lens) => ({
    lens,
    findings: skippedByFloor ? 0 : (findingsByLens.get(lens) ?? 0),
    skippedByFloor,
  }));
}
