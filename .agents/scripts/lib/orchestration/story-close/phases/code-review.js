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
 */

import { Logger } from '../../../Logger.js';
import { runCodeReview } from '../../code-review.js';
import { emitStoryBlockedSafe } from '../merge-runner.js';

/**
 * Build the blocked-result envelope for a critical-finding outcome.
 * Mirrors `emitBaselineBlockedResult` (status: 'blocked', phase:
 * 'closing', success: false) plus `exitCode: 1` so the CLI shell
 * exits non-zero — the task acceptance pins this.
 */
function buildBlockedResult({ storyId, reviewResult }) {
  const severity = reviewResult?.severity ?? {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  };
  return {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: 'code-review-critical',
    storyId: Number(storyId),
    blockerReason: reviewResult?.blockerReason ?? null,
    severity,
    posted: reviewResult?.posted ?? false,
    exitCode: 1,
  };
}

/**
 * Run a Story-scope code review against the `epic/<id>`…`story-<id>`
 * diff and post the structured `code-review` comment to the Story
 * issue. Returns `{ blocked }` where `blocked` is either `null`
 * (caller proceeds to merge) or the blocked-envelope (caller returns
 * it verbatim and the CLI exits 1).
 *
 * @param {{
 *   storyId: number|string,
 *   epicBranch: string,
 *   storyBranch: string,
 *   provider: object,
 *   bus: { emit: Function }|null,
 *   progress: (tag: string, msg: string) => void,
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
    runCodeReviewFn = runCodeReview,
  } = args;

  const storyIdNum = Number(storyId);
  progress(
    'CODE-REVIEW',
    `Running Story-scope review (${epicBranch}…${storyBranch})...`,
  );

  let reviewResult;
  try {
    reviewResult = await runCodeReviewFn({
      scope: 'story',
      ticketId: storyIdNum,
      baseRef: epicBranch,
      headRef: storyBranch,
      provider,
      logger: {
        info: (m) => progress('CODE-REVIEW', m),
        warn: (m) => progress('CODE-REVIEW', `⚠️ ${m}`),
      },
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
    progress(
      'BLOCKED',
      `Story #${storyIdNum} blocked: code-review reported ${reviewResult.severity.critical} critical blocker(s).`,
    );
    await emitStoryBlockedSafe({
      bus,
      storyId: storyIdNum,
      reason: 'code-review-critical',
      logger: Logger,
    });
    const blocked = buildBlockedResult({
      storyId: storyIdNum,
      reviewResult,
    });
    Logger.info(
      `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(blocked, null, 2)}\n--- END RESULT ---\n`,
    );
    return { blocked };
  }

  const counts = reviewResult?.severity ?? {};
  progress(
    'CODE-REVIEW',
    `Review complete — high=${counts.high ?? 0} medium=${counts.medium ?? 0} suggestion=${counts.suggestion ?? 0} (posted=${reviewResult?.posted ?? false}).`,
  );
  return { blocked: null };
}
