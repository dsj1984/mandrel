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
import { emitBlockedCloseResult } from '../emit-blocked.js';

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
 * Review depth is not passed in: `runCodeReview` derives it entirely from the
 * `baseRef...headRef` diff it enumerates itself — the changed files' sensitive-
 * path intersection plus their count (Story #4542, which retired the
 * planner-authored risk envelope this spine used to forward). Depth remains an
 * **input-only** signal: it tells the provider how thorough to be and never
 * alters the review's output envelope or the posted structured-comment body.
 *
 * @param {{
 *   storyId: number|string,
 *   baseRef: string,
 *   headRef: string,
 *   commentTargetId?: number|null,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   progressTag?: string,
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
export async function runStoryCodeReview(args) {
  const {
    storyId,
    baseBranch,
    storyBranch,
    provider,
    bus,
    progress,
    runCodeReviewFn = runCodeReview,
    runLocalLensReviewFn = runLocalLensReview,
  } = args;

  const storyIdNum = Number(storyId);
  progress(
    'CODE-REVIEW',
    `Running Story-scope review (${baseBranch}…${storyBranch})...`,
  );

  let reviewResult;
  try {
    reviewResult = await runStoryReviewCore({
      storyId: storyIdNum,
      baseRef: baseBranch,
      headRef: storyBranch,
      provider,
      progress,
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
