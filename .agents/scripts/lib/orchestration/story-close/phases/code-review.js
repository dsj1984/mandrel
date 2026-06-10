/**
 * phases/code-review.js — Story-scope code-review phase
 * (Story #2840, Epic #2815 — Pluggable Code Review + Story-Level Review).
 *
 * Sits between the close-validation gate chain and the merge into
 * `epic/<id>` inside `runStoryCloseLocked` (locked-pipeline.js). The
 * configured ReviewProvider runs against the
 * `epic/<id>`…`story-<id>` diff. The structured `code-review` comment
 * is posted to the Story issue (default `commentTargetId === ticketId`
 * inside `runCodeReview`). Outcomes:
 *
 *   - clean / non-critical findings → `{ blocked: null }`; the pipeline
 *     proceeds to merge.
 *   - critical findings              → `{ blocked: <envelope> }`; the
 *     pipeline short-circuits, the Story is not merged, and the CLI
 *     exits non-zero via `exitCode: 1` on the envelope.
 *   - adapter throw / wiring failure → `{ blocked: null }`; the close
 *     proceeds because the review surface is advisory for transport
 *     failures (the same posture refresh.js takes). A warn is logged.
 *
 * Bus contract: `runCodeReview` only emits lifecycle events for
 * `scope: 'epic'` (the `code-review.end` schema requires `epicId`
 * and the ledger only spans Epic lifecycles — see Story #2839 lock-in
 * in `code-review.js`). The Story-scope path here therefore does not
 * forward the bus, and `story.blocked` is emitted separately on the
 * critical-halt path so the Epic-scoped lifecycle ledger still sees
 * the Story drop out.
 *
 * `runStoryReviewCore` is exported as the shared spine that the
 * `single-story-close` path imports, so both close paths call `runCodeReview`
 * through a single implementation rather than each maintaining its own
 * invocation pattern (Story #3653).
 */

import { Logger } from '../../../Logger.js';
import { runCodeReview } from '../../code-review.js';
import { emitBlockedCloseResult } from '../merge-runner.js';

/**
 * Collect the extra fields for the code-review-critical blocked envelope.
 * Pure; used by `runStoryCodeReview` to populate the `extra` argument of
 * `emitBlockedCloseResult`.
 */
function buildCodeReviewBlockedExtra({ storyId, reviewResult }) {
  const severity = reviewResult?.severity ?? {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  };
  return {
    storyId: Number(storyId),
    blockerReason: reviewResult?.blockerReason ?? null,
    severity,
    posted: reviewResult?.posted ?? false,
    exitCode: 1,
  };
}

/**
 * Invoke `runCodeReviewFn` with the canonical Story-scope envelope and return
 * the raw result. Shared by both the Epic-attached close path
 * (`runStoryCodeReview`) and the standalone close path
 * (`single-story-close/phases/code-review.js#runStoryScopeReview`) so the
 * invocation pattern lives in one place (Story #3653).
 *
 * The caller is responsible for error handling and result interpretation —
 * this function propagates throws rather than swallowing them, because the
 * two callers have different advisory postures:
 *
 *   - Epic-attached close: swallows throws (non-blocking advisory, same as
 *     `refresh.js`).
 *   - Standalone close: propagates throws (a review failure stops the close).
 *
 * The optional `planningRisk` envelope (Story #3940) is forwarded verbatim to
 * `runCodeReview`, which folds its `overallLevel` together with the
 * `baseRef...headRef` changed-file count (which `runCodeReview` enumerates
 * itself, scoped to the diff under review) into the review depth via the
 * shared {@link resolveDepth} resolver. It is an **input-only** signal: it
 * tells the provider how thorough to be and never alters the review's output
 * envelope or the posted structured-comment body. Absent (`null` / `undefined`,
 * the standalone close path) → `runCodeReview` resolves the neutral depth from
 * diff width alone, byte-identical to the pre-#3940 behaviour.
 *
 * @param {{
 *   storyId: number|string,
 *   baseRef: string,
 *   headRef: string,
 *   commentTargetId?: number|null,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 *   planningRisk?: { overallLevel?: ('low'|'medium'|'high'), axes?: Array<{ axis?: string, level?: string }> }|null,
 *   runCodeReviewFn?: typeof runCodeReview,
 * }} args
 * @returns {Promise<object>} Raw result envelope from `runCodeReview`.
 */
export async function runStoryReviewCore({
  storyId,
  baseRef,
  headRef,
  commentTargetId = null,
  provider,
  progress,
  progressTag = 'CODE-REVIEW',
  planningRisk = null,
  runCodeReviewFn = runCodeReview,
}) {
  const storyIdNum = Number(storyId);
  const opts = {
    scope: 'story',
    ticketId: storyIdNum,
    baseRef,
    headRef,
    provider,
    logger: {
      info: (m) => progress(progressTag, m),
      warn: (m) => progress(progressTag, `⚠️ ${m}`),
    },
  };
  if (commentTargetId != null) {
    opts.commentTargetId = commentTargetId;
  }
  // Forward the parent Epic's judged risk only on the Epic-attached path; the
  // standalone caller leaves this null so `runCodeReview` resolves depth from
  // diff width alone (no plan checkpoint exists for a standalone Story).
  if (planningRisk != null) {
    opts.planningRisk = planningRisk;
  }
  return runCodeReviewFn(opts);
}

/**
 * Run a Story-scope code review against the `epic/<id>`…`story-<id>`
 * diff and post the structured `code-review` comment to the Story
 * issue. Returns `{ blocked }` where `blocked` is either `null`
 * (caller proceeds to merge) or the blocked-envelope (caller returns
 * it verbatim and the CLI exits 1).
 *
 * The optional `planningRisk` envelope (Story #3940) is the parent Epic's
 * judged risk, read best-effort off the `epic-plan-state` checkpoint by the
 * locked pipeline. It is forwarded into `runCodeReview` so the review depth is
 * resolved from BOTH the Epic-judged risk and the Story's own
 * `epic/<id>...story-<id>` changed-file count — a small Story under a
 * high-risk Epic still earns `deep`, a small Story under a low-risk Epic gets
 * `light`, and an absent envelope resolves `standard` (today's behaviour).
 * Depth is input-only: it never changes `{ blocked }` or the posted comment.
 *
 * @param {{
 *   storyId: number|string,
 *   epicBranch: string,
 *   storyBranch: string,
 *   provider: object,
 *   bus: { emit: Function }|null,
 *   progress: (tag: string, msg: string) => void,
 *   planningRisk?: { overallLevel?: ('low'|'medium'|'high'), axes?: Array<{ axis?: string, level?: string }> }|null,
 *   runCodeReviewFn?: typeof runCodeReview,
 * }} args
 * @returns {Promise<{ blocked: object|null }>}
 */
export async function runStoryCodeReview(args) {
  const {
    storyId,
    epicBranch,
    storyBranch,
    provider,
    bus,
    progress,
    planningRisk = null,
    runCodeReviewFn = runCodeReview,
  } = args;

  const storyIdNum = Number(storyId);
  progress(
    'CODE-REVIEW',
    `Running Story-scope review (${epicBranch}…${storyBranch})...`,
  );

  let reviewResult;
  try {
    reviewResult = await runStoryReviewCore({
      storyId: storyIdNum,
      baseRef: epicBranch,
      headRef: storyBranch,
      provider,
      progress,
      planningRisk,
      runCodeReviewFn,
    });
  } catch (err) {
    // Adapter / wiring failure — log and proceed. The review is advisory
    // when the provider cannot complete; the gates already vouched for
    // the diff at this point.
    Logger.warn?.(
      `[story-close] ⚠️ code-review phase failed (continuing without blocker): ${err?.message ?? err}`,
    );
    return { blocked: null };
  }

  if (reviewResult?.halted) {
    const blocked = await emitBlockedCloseResult({
      storyId: storyIdNum,
      phase: 'closing',
      reason: 'code-review-critical',
      extra: buildCodeReviewBlockedExtra({ storyId: storyIdNum, reviewResult }),
      bus,
      progress,
      blockedMessage: `Story #${storyIdNum} blocked: code-review reported ${reviewResult.severity.critical} critical blocker(s).`,
      logger: Logger,
    });
    return { blocked };
  }

  const counts = reviewResult?.severity ?? {};
  progress(
    'CODE-REVIEW',
    `Review complete — high=${counts.high ?? 0} medium=${counts.medium ?? 0} suggestion=${counts.suggestion ?? 0} (posted=${reviewResult?.posted ?? false}).`,
  );
  return { blocked: null };
}
