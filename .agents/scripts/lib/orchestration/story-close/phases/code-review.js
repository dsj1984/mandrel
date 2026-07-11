/**
 * phases/code-review.js — Story-scope code-review phase
 * (Story #2840, Epic #2815 — Pluggable Code Review + Story-Level Review).
 *
 * Sits between the close-validation gate chain and the merge into
 * `epic/<id>` inside `runStoryCloseLocked` (locked-pipeline.js). The
 * configured ReviewProvider runs against the
 * `epic/<id>`…`story-<id>` diff. The unified `verification-results`
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
 * `runStoryReviewCore` is exported as the shared spine that the
 * `single-story-close` path imports, so both close paths call `runCodeReview`
 * through a single implementation rather than each maintaining its own
 * invocation pattern (Story #3653).
 */

import {
  runAuditSuite,
  selectLocalLenses,
} from '../../../audit-suite/index.js';
import { gitSpawn } from '../../../git-utils.js';
import { Logger } from '../../../Logger.js';
import { runCodeReview } from '../../code-review.js';
import { emitBlockedCloseResult } from '../merge-runner.js';

/**
 * The review depth the Story-scope local-lens pass runs at. Shift-left
 * (Epic #4405): local concerns are cheap to decide on a single Story's diff, so
 * the maker-blind Story-scope review runs its matched local lenses at `light`
 * depth here rather than paying a deeper pass at Epic close. Fixed for this
 * tier — it is not risk-scaled like the code-review pillar depth.
 */
export const STORY_SCOPE_LENS_DEPTH = 'light';

/**
 * Enumerate the files changed in the `baseRef...headRef` diff via
 * `git diff --name-only`. Best-effort: returns `[]` when the diff cannot be
 * enumerated (git failure, missing ref) and never throws, mirroring the
 * advisory posture of the surrounding review phase. Synchronous `gitSpawn`
 * (returns `{ status, stdout }`) is the same seam `code-review.js#countChangedFiles`
 * uses.
 *
 * @param {{ baseRef: string, headRef: string, gitSpawnFn?: typeof gitSpawn }} args
 * @returns {string[]} Changed file paths, or `[]` on any failure.
 */
export function enumerateChangedFiles({
  baseRef,
  headRef,
  gitSpawnFn = gitSpawn,
}) {
  try {
    const result = gitSpawnFn(
      process.cwd(),
      'diff',
      '--name-only',
      `${baseRef}...${headRef}`,
    );
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
      return [];
    }
    return result.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Run the Story-scope local-lens pass: select the LOCAL-tier lenses whose
 * `filePatterns` match the actual Story diff (`baseRef...headRef`) and
 * materialize their lens-prompt bodies at `light` depth. This is the
 * shift-left tier from Epic #4405 — it runs **inside** the story-close
 * subprocess spine (called only from {@link runStoryReviewCore}), never in the
 * delivering child's (maker's) context, so a maker never grades its own work.
 *
 * A diff that matches no local lens adds **no** lens work: the roster is empty
 * and `runAuditSuite` is never invoked. Best-effort and total — a git or
 * materialization failure degrades to `{ skipped: true, lenses: [] }` and is
 * logged via `progress`, matching the advisory posture the review phase already
 * takes for provider/transport failures.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 *   selectLocalLensesFn?: typeof selectLocalLenses,
 *   runAuditSuiteFn?: typeof runAuditSuite,
 * }} args
 * @returns {Promise<{
 *   depth: 'light',
 *   lenses: string[],
 *   skipped: boolean,
 *   materialized: object|null,
 * }>}
 */
export async function runLocalLensReview({
  baseRef,
  headRef,
  progress,
  progressTag = 'CODE-REVIEW',
  gitSpawnFn = gitSpawn,
  selectLocalLensesFn = selectLocalLenses,
  runAuditSuiteFn = runAuditSuite,
}) {
  const empty = {
    depth: STORY_SCOPE_LENS_DEPTH,
    lenses: [],
    skipped: true,
    materialized: null,
  };
  let lenses;
  try {
    const changedFiles = enumerateChangedFiles({
      baseRef,
      headRef,
      gitSpawnFn,
    });
    lenses = selectLocalLensesFn({ changedFiles });
    if (lenses.length === 0) {
      progress(
        progressTag,
        'No local lens matched the Story diff — skipping the lens pass.',
      );
      return empty;
    }
    const materialized = await runAuditSuiteFn({ auditWorkflows: lenses });
    progress(
      progressTag,
      `Ran ${lenses.length} local lens(es) at ${STORY_SCOPE_LENS_DEPTH} depth: ${lenses.join(', ')}.`,
    );
    return {
      depth: STORY_SCOPE_LENS_DEPTH,
      lenses,
      skipped: false,
      materialized,
    };
  } catch (err) {
    // The lens pass is advisory: a git or materialization failure must not
    // fail the close. Log and degrade to a skipped envelope.
    progress(
      progressTag,
      `⚠️ local lens pass failed (continuing without it): ${err?.message ?? err}`,
    );
    return empty;
  }
}

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
 *   runLocalLensReviewFn?: typeof runLocalLensReview,
 * }} args
 * @returns {Promise<object>} Raw result envelope from `runCodeReview`, augmented
 *   with a `localLensReview` field carrying the Story-scope local-lens pass
 *   outcome (Epic #4405, Story #4409). Both close entry points reach the lens
 *   pass through this single spine, so it runs on the Epic-attached and
 *   standalone paths alike and always inside the close subprocess.
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
  runLocalLensReviewFn = runLocalLensReview,
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

  // Shift-left local-lens pass (Epic #4405). Runs matched local lenses at
  // `light` depth against the actual Story diff, inside this close-subprocess
  // spine so the maker never grades its own work. Advisory — it never blocks
  // the close and its outcome rides on the returned envelope for downstream
  // consumers.
  const localLensReview = await runLocalLensReviewFn({
    baseRef,
    headRef,
    progress,
    progressTag,
  });

  const result = await runCodeReviewFn(opts);
  return { ...result, localLensReview };
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
 *   runLocalLensReviewFn?: typeof runLocalLensReview,
 * }} args
 * @returns {Promise<{ blocked: object|null, localLensReview?: object }>}
 *   `localLensReview` carries the Story-scope local-lens pass outcome
 *   (Epic #4405, Story #4409) when the review completed; it is absent only when
 *   the whole review phase threw (advisory failure).
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
    runLocalLensReviewFn = runLocalLensReview,
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
      runLocalLensReviewFn,
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

  const localLensReview = reviewResult?.localLensReview;

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
    return { blocked, localLensReview };
  }

  const counts = reviewResult?.severity ?? {};
  progress(
    'CODE-REVIEW',
    `Review complete — high=${counts.high ?? 0} medium=${counts.medium ?? 0} suggestion=${counts.suggestion ?? 0} (posted=${reviewResult?.posted ?? false}).`,
  );
  return { blocked: null, localLensReview };
}
