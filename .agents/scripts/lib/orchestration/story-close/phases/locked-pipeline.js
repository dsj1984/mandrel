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
import { dispatchRecovery } from '../../story-close-recovery.js';
import {
  buildLegacyOrchestrationBag,
  buildLegacySettingsBag,
} from '../legacy-settings-bag.js';
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
    agentSettings: ctx.agentSettings,
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
        agentSettings: ctx.agentSettings,
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
      agentSettings: ctx.agentSettings,
    },
    { progress: ctx.progress },
  );
  return { blocked: null };
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

  // Bridge the canonical config into the legacy bags that the gate
  // helpers under `lib/orchestration/story-close/**` still expect.
  // Removed in the follow-on that migrates those helpers (see
  // `legacy-settings-bag.js` header).
  const agentSettings = buildLegacySettingsBag(config);
  const orchestration = buildLegacyOrchestrationBag(config);

  // Augment args downstream so helpers that destructure `agentSettings` /
  // `orchestration` keep working without each caller site rebuilding the bags.
  args = { ...args, agentSettings, orchestration };

  // Prior-state detection + --resume / --restart dispatch.
  const { resumeFromConflict, resumeFromMerge, resumeFromPostMerge } =
    dispatchRecovery({
      cwd,
      storyId,
      epicId,
      epicBranch,
      storyBranch,
      orchestration,
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
    const review = await runStoryCodeReview({
      storyId: ctx.storyId,
      epicBranch: ctx.epicBranch,
      storyBranch: ctx.storyBranch,
      provider: ctx.provider,
      bus: ctx.bus,
      progress: ctx.progress,
    });
    if (review.blocked) return review.blocked;
  }

  // Everything past validation is the `close` phase; the post-merge
  // pipeline marks `api-sync` once the merge lands.
  phaseTimer.mark('close');

  return runClosePhase(ctx);
}
