/**
 * phases/locked-pipeline.js — the per-Epic-merge-lock-protected body of
 * `runStoryClose` (Story #2460, Epic #2453 — CLI thinning pilot).
 *
 * Sits behind `withEpicMergeLock` in story-close.js. Owns:
 *
 *   1. dispatchRecovery     — prior-state detection + --resume / --restart
 *      dispatch
 *   2. fetchChildTickets      — hydrate the cascade target set
 *   3. phase-timer restore  — pick up the snapshot story-init wrote
 *   4. gates                — pre-merge validation (skipped on resume)
 *   5. refresh              — bounded baseline auto-refresh (gates ok path)
 *   6. close                — merge + post-merge close pipeline
 *
 * The split out of story-close.js keeps the CLI shell at ≤ 300 LOC and
 * means a future test can drive the locked pipeline with the lock
 * mocked out — without re-acquiring the per-Epic lock or re-entering
 * the preflight gate.
 */

import { Logger } from '../../../Logger.js';
import { fetchChildTickets } from '../../../story-lifecycle.js';
import { createPhaseTimer } from '../../../util/phase-timer.js';
import {
  clearPhaseTimerState,
  loadPhaseTimerState,
} from '../../../util/phase-timer-state.js';
import { read as readPlanState } from '../../epic-plan-state-store.js';
import { dispatchRecovery } from '../../story-close-recovery.js';
import { runClosePhase } from './close.js';
import { runStoryCodeReview } from './code-review.js';
import {
  emitBaselineBlockedResult,
  runPreMergeValidation,
  shouldSkipValidation,
} from './gates.js';
import { runAutoRefreshSafely } from './refresh.js';
import { emitSpawnTimeoutBlockedResult } from './timeout-blocked-emitter.js';

/**
 * Run pre-merge gates and, on a clean outcome, the bounded baseline
 * auto-refresh. Returns `{ blocked }` so the locked pipeline can
 * short-circuit on a `blocked` / `blocked-timeout` gate outcome.
 */
async function runGatesAndRefresh(ctx) {
  const gateOutcome = await runPreMergeValidation({
    cwd: ctx.cwd,
    worktreePath: ctx.worktreePath,
    epicBranch: ctx.epicBranch,
    storyBranch: ctx.storyBranch,
    config: ctx.config,
    storyId: ctx.storyId,
    epicId: ctx.epicId,
    noEvidenceFlag: ctx.noEvidenceFlag,
    phaseTimer: ctx.phaseTimer,
    provider: ctx.provider,
    bus: ctx.bus,
  });
  if (gateOutcome?.status === 'blocked') {
    return {
      blocked: await emitBaselineBlockedResult({
        storyId: ctx.storyId,
        gateOutcome,
        progress: ctx.progress,
        bus: ctx.bus,
      }),
    };
  }
  if (gateOutcome?.status === 'blocked-timeout') {
    return {
      blocked: await emitSpawnTimeoutBlockedResult({
        storyId: ctx.storyId,
        epicId: ctx.epicId,
        spawnName: gateOutcome.gateName ?? 'coverage-capture',
        spawnCmd: gateOutcome.spawnCmd ?? null,
        timeoutMs: gateOutcome.timeoutMs ?? null,
        exitCode: gateOutcome.exitCode ?? 124,
        config: ctx.config,
        provider: ctx.provider,
        progress: ctx.progress,
        bus: ctx.bus,
      }),
    };
  }
  await runAutoRefreshSafely(
    {
      storyId: ctx.storyId,
      epicId: ctx.epicId,
      cwd: ctx.worktreePath || ctx.cwd,
      epicBranch: ctx.epicBranch,
      storyBranch: ctx.storyBranch,
      config: ctx.config,
    },
    { progress: ctx.progress },
  );
  return { blocked: null };
}

/**
 * Read the parent Epic's judged `planningRisk` envelope off its
 * `epic-plan-state` checkpoint so the Story-scope review can inherit the
 * Epic's review depth (Story #3940). Best-effort and total — it reuses the
 * shared `read` from `epic-plan-state-store.js` (the same reader `/epic-plan
 * --resume` and `epic-audit-prepare.js`'s `resolveRiskRoutedLenses` use, no
 * third bespoke reader) and never fails the close:
 *
 *   - absent/non-integer `epicId` (a Story that is not Epic-attached) → `null`
 *   - missing/unparseable checkpoint, no `planningRisk` field → `null`
 *   - any read throw (provider error, malformed comment) → `null`
 *
 * A `null` result threads through `runStoryCodeReview` → `runCodeReview`
 * unchanged, so depth resolves from diff width alone (`standard`), preserving
 * today's behaviour for an Epic that skipped `/epic-plan`.
 *
 * @param {{ provider: object, epicId: number|null|undefined, readPlanStateFn?: typeof readPlanState }} args
 * @returns {Promise<{ overallLevel?: string, axes?: Array<object> }|null>}
 */
export async function resolveParentEpicPlanningRisk({
  provider,
  epicId,
  readPlanStateFn = readPlanState,
}) {
  if (!Number.isInteger(epicId) || epicId <= 0) return null;
  try {
    const state = await readPlanStateFn({ provider, epicId });
    return state?.planningRisk ?? null;
  } catch {
    return null;
  }
}

/**
 * Body of `withEpicMergeLock(epicId, ..., () => …)` from story-close.js.
 *
 * @param {object} args - resolved-close-input bundle from
 *   `resolveCloseInputs` plus the orchestrator-injected `progress` /
 *   `progressLog` callbacks and the lifecycle bus.
 * @returns {Promise<{ success: boolean, result?: object } | object>}
 */
export async function runStoryCloseLocked(args) {
  const {
    cwd,
    storyId,
    epicId,
    epicBranch,
    storyBranch,
    config,
    skipValidationParam,
    resumeFlag,
    restartFlag,
    provider,
    story,
    progress,
  } = args;

  // Prior-state detection + --resume / --restart dispatch.
  // `dispatchRecovery` only reads `orchestration.worktreeIsolation`; surface
  // it from the canonical `delivery.worktreeIsolation` view directly.
  const { resumeFromConflict, resumeFromMerge, resumeFromPostMerge } =
    dispatchRecovery({
      cwd,
      storyId,
      epicId,
      epicBranch,
      storyBranch,
      orchestration: { worktreeIsolation: config.delivery?.worktreeIsolation },
      resume: resumeFlag,
      restart: restartFlag,
      progress,
      logger: Logger,
    });

  const tasks = await fetchChildTickets(provider, storyId);
  provider.primeTicketCache([story, ...tasks]);
  progress('TICKETS', `Found ${tasks.length} child ticket(s)`);

  const prior = loadPhaseTimerState({ mainCwd: cwd, storyId });
  const phaseTimer = createPhaseTimer(storyId, prior ? { restore: prior } : {});

  const skipValidation = shouldSkipValidation({
    skipValidationParam,
    resumeFromConflict,
    resumeFromMerge,
    resumeFromPostMerge,
  });

  const ctx = {
    ...args,
    tasks,
    phaseTimer,
    resumeFromConflict,
    resumeFromMerge,
    resumeFromPostMerge,
    clearPhaseTimerState,
  };

  if (!skipValidation) {
    const { blocked } = await runGatesAndRefresh(ctx);
    if (blocked) return blocked;

    // Story #2840 — Story-scope code review runs after the gate chain
    // passes (so we know the diff is build-clean) but before the merge
    // into `epic/<id>`. Critical findings short-circuit the close and
    // exit non-zero; non-critical findings post a structured comment
    // and let close proceed.
    //
    // Story #3940 — the review inherits the parent Epic's judged review
    // depth: read the Epic's `planningRisk` envelope best-effort off its
    // `epic-plan-state` checkpoint and forward it so `runCodeReview`
    // resolves depth from BOTH that risk and the Story-scope
    // (`epic/<id>...story-<id>`) changed-file count. A missing/unreadable
    // checkpoint degrades to `null` (→ `standard`) without failing close.
    const planningRisk = await resolveParentEpicPlanningRisk({
      provider: ctx.provider,
      epicId: ctx.epicId,
    });
    const review = await runStoryCodeReview({
      storyId: ctx.storyId,
      epicBranch: ctx.epicBranch,
      storyBranch: ctx.storyBranch,
      provider: ctx.provider,
      bus: ctx.bus,
      progress: ctx.progress,
      planningRisk,
    });
    if (review.blocked) return review.blocked;
  }

  // Everything past validation is the `close` phase; the post-merge
  // pipeline marks `api-sync` once the merge lands.
  phaseTimer.mark('close');

  return runClosePhase(ctx);
}
