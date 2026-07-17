/**
 * phases/code-review.js — Story-scope code-review phase
 * (Story #2840, Epic #2815 — Pluggable Code Review + Story-Level Review).
 *
 * Sits between the close-validation gate chain and merge in the deleted
 * pre-v2 Epic close path (`runStoryCloseLocked` / `locked-pipeline.js`,
 * merge target `epic/<id>`). The v2 `/deliver` path
 * (`single-story-close.js`) reviews `main`…`story-<id>` instead. The
 * configured ReviewProvider runs against the supplied base…head diff. The
 * unified `verification-results`
 * structured comment is posted to the Story issue (default
 * `commentTargetId === ticketId` inside `runCodeReview`). Outcomes:
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
 * The shared spine both close paths call `runCodeReview` through
 * (`runStoryReviewCore`, Story #3653) and the shift-left local-lens pass
 * (Epic #4405) live in `review-core.js` and `local-lens-review.js`
 * respectively (extracted by Story #4603). This module is the Epic-attached
 * phase entry point: it owns the advisory error posture and the
 * critical-halt → blocked-envelope translation, and nothing else.
 */

import { Logger } from '../../../Logger.js';
import { runCodeReview } from '../../code-review.js';
import { emitBlockedCloseResult } from '../emit-blocked.js';
import { runLocalLensReview } from './local-lens-review.js';
import { runStoryReviewCore } from './review-core.js';

/**
 * Read a review envelope's severity counts, tolerating the partial envelope a
 * misbehaving provider adapter can return. Pure.
 *
 * @param {object|null|undefined} reviewResult
 * @returns {{ critical: number, high: number, medium: number, suggestion: number }}
 */
function resolveSeverity(reviewResult) {
  return (
    reviewResult?.severity ?? {
      critical: 0,
      high: 0,
      medium: 0,
      suggestion: 0,
    }
  );
}

/**
 * Collect the extra fields for the code-review-critical blocked envelope. Pure.
 *
 * @param {{ storyId: number, reviewResult: object }} args
 * @returns {object}
 */
function buildCodeReviewBlockedExtra({ storyId, reviewResult }) {
  return {
    storyId,
    blockerReason: reviewResult?.blockerReason ?? null,
    severity: resolveSeverity(reviewResult),
    posted: reviewResult?.posted ?? false,
    exitCode: 1,
  };
}

/**
 * Render the operator-facing one-line summary of a completed (non-halting)
 * review. Pure.
 *
 * @param {object} reviewResult
 * @returns {string}
 */
function formatReviewSummary(reviewResult) {
  const { high, medium, suggestion } = resolveSeverity(reviewResult);
  const posted = reviewResult?.posted ?? false;
  return `Review complete — high=${high} medium=${medium} suggestion=${suggestion} (posted=${posted}).`;
}

/**
 * Run the shared review spine, absorbing an adapter / wiring failure into this
 * phase's advisory posture: the review is best-effort when the provider cannot
 * complete, and the gates already vouched for the diff at this point.
 *
 * @param {object} args Spine arguments (see {@link runStoryReviewCore}).
 * @returns {Promise<object|null>} The review envelope, or `null` when the
 *   review threw and the close should proceed unblocked.
 */
async function invokeReviewCore(args) {
  try {
    return await runStoryReviewCore(args);
  } catch (err) {
    Logger.warn?.(
      `[story-close] ⚠️ code-review phase failed (continuing without blocker): ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Translate a halting (critical-findings) review into the blocked envelope the
 * caller returns verbatim, emitting `story.blocked` onto the bus on the way.
 *
 * @param {{
 *   storyId: number,
 *   reviewResult: object,
 *   bus: { emit: Function }|null,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<object>} The blocked envelope.
 */
async function emitCriticalBlock({ storyId, reviewResult, bus, progress }) {
  const { critical } = resolveSeverity(reviewResult);
  return emitBlockedCloseResult({
    storyId,
    phase: 'closing',
    reason: 'code-review-critical',
    extra: buildCodeReviewBlockedExtra({ storyId, reviewResult }),
    bus,
    progress,
    blockedMessage: `Story #${storyId} blocked: code-review reported ${critical} critical blocker(s).`,
    logger: Logger,
  });
}

/**
 * Run a Story-scope code review against the supplied base…head diff
 * (v2: `main`…`story-<id>` via `single-story-close.js`; pre-v2 Epic
 * close: `epic/<id>`…`story-<id>`) and post the structured
 * `code-review` comment to the Story issue. Returns `{ blocked }` where
 * `blocked` is either `null` (caller proceeds to open/merge the PR) or the
 * blocked-envelope (caller returns it verbatim and the CLI exits 1).
 *
 * Review depth is derived inside `runCodeReview` from this Story's own base…head
 * diff — a narrow change touching a registered sensitive path earns `deep`, a
 * small change touching none gets `light`, a wide diff earns `deep` on size, and
 * an unenumerable diff resolves `standard` (Story #4542). Depth is input-only:
 * it never changes `{ blocked }` or the posted comment.
 *
 * @param {{
 *   storyId: number|string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   provider: object,
 *   bus: { emit: Function }|null,
 *   progress: (tag: string, msg: string) => void,
 *   runCodeReviewFn?: typeof runCodeReview,
 *   runLocalLensReviewFn?: typeof runLocalLensReview,
 * }} args
 * @returns {Promise<{ blocked: object|null, localLensReview?: object }>}
 *   `localLensReview` carries the Story-scope local-lens pass outcome
 *   (Epic #4405, Story #4409) when the review completed; it is absent only when
 *   the whole review phase threw (advisory failure).
 */
export async function runStoryCodeReview({
  storyId,
  baseBranch,
  storyBranch,
  provider,
  bus,
  progress,
  runCodeReviewFn = runCodeReview,
  runLocalLensReviewFn = runLocalLensReview,
}) {
  const storyIdNum = Number(storyId);
  progress(
    'CODE-REVIEW',
    `Running Story-scope review (${baseBranch}…${storyBranch})...`,
  );

  const reviewResult = await invokeReviewCore({
    storyId: storyIdNum,
    baseRef: baseBranch,
    headRef: storyBranch,
    provider,
    progress,
    runCodeReviewFn,
    runLocalLensReviewFn,
  });
  if (reviewResult === null) return { blocked: null };

  const localLensReview = reviewResult.localLensReview;
  if (reviewResult.halted) {
    const blocked = await emitCriticalBlock({
      storyId: storyIdNum,
      reviewResult,
      bus,
      progress,
    });
    return { blocked, localLensReview };
  }

  progress('CODE-REVIEW', formatReviewSummary(reviewResult));
  return { blocked: null, localLensReview };
}
