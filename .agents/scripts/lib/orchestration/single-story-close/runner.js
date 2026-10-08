import {
  BASELINES_GATE_NAMES,
  buildDefaultGates,
} from '../../close-validation/gates.js';
import { runCloseValidation } from '../../close-validation/runner.js';
import { getCiDelivery } from '../../config/ci.js';
import { resolveWorktreeEnabled } from '../../config/runtime.js';
import { resolveConfig } from '../../config-resolver.js';
import { gh as defaultGh } from '../../gh-exec.js';
import { getStoryBranch, gitSpawn, gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import {
  emitReviewBlockedFriction,
  recordCloseTelemetry,
  resolveWorkerModel,
  resolveWorkerTokens,
} from '../../observability/close-telemetry.js';
import { emitTerminalFriction } from '../../observability/runtime-friction.js';
import { emitTerseResult } from '../../observability/terse-result.js';
import { createProvider } from '../../provider-factory.js';
import { flipLabelAndNotify } from '../../single-story/story-merged-notify.js';
import { WorktreeManager } from '../../worktree-manager.js';
import { runCodeReview as runCodeReviewDefault } from '../code-review.js';
import { MERGED_FLIP_FAILED_BLOCK_CLASS } from '../lifecycle/emit-merge-flip-failed.js';
import { resolveRunScopedConfig } from '../run-scoped-config.js';
import { releaseStoryLease } from '../single-story-lease-guard.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  NEXT_COMMANDS,
  terminalFromWaitOutcome,
} from '../story-deliver-terminal.js';
import { createStoryProgress } from '../story-progress.js';
import { deriveCloseNote } from './close-note.js';
import { closeArmedPr, runAutoMergePhase } from './phases/auto-merge.js';
import { runBaseSyncPhase } from './phases/base-sync.js';
import { runCloseValidationPhase } from './phases/close-validation.js';
import { parsePrNumber } from './phases/code-review.js';
import { runConfirmMergePhase } from './phases/confirm-merge.js';
import { runGraphqlPreflight } from './phases/graphql-preflight.js';
import { lockWaitPending } from './phases/lock-wait-pending.js';
import { parseCloseOptions, resolveWaitForMerge } from './phases/options.js';
import { runPostLandTail } from './phases/post-land.js';
import {
  ensurePullRequestWith,
  pickHeadPullRequest,
} from './phases/pull-request.js';
import { pushStoryBranch } from './phases/push.js';
import { handleCriticalReviewBlock } from './phases/review-block.js';
import { handleOverriddenReviewBlock } from './phases/review-override.js';
import {
  existingWorktreePath,
  resolveStoryWorktree,
} from './phases/worktree-restore.js';
import { runWrongTreeGuardPhase } from './phases/wrong-tree-guard.js';
import {
  discardHeldReview,
  reviewAfterPrOpen,
  startHeldReview,
} from './review-overlap.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Wall-clock seconds per named phase; each transition logs the phase it ends.
 * Overlapping work `pause`s the clock and `record`s its own time.
 *
 * @param {() => number} [nowMs]
 */
function createPhaseTimer(nowMs = Date.now) {
  const durations = {};
  let current = null;
  let since = 0;
  const record = (phase, ms) => {
    const seconds = Math.round(Math.max(0, ms) / 100) / 10;
    durations[phase] = (durations[phase] ?? 0) + seconds;
    progress('TIMING', `⏱  ${phase}: ${seconds}s`);
  };
  const end = () => {
    if (current === null) return;
    record(current, nowMs() - since);
    current = null;
  };
  return {
    enter(phase) {
      end();
      if (phase === 'init') return;
      current = phase;
      since = nowMs();
    },
    record,
    pause: end,
    finish() {
      end();
      return Object.keys(durations).length > 0 ? { ...durations } : null;
    },
    stamp(terminal) {
      const phaseDurations = this.finish();
      if (phaseDurations) terminal.phaseDurations = phaseDurations;
    },
  };
}

const UNTIMED = Object.freeze({ stamp() {} });

/** No worker figures: an inline close, or an ending before they resolve. */
const NO_WORKER = Object.freeze({ workerTokens: null, workerModel: null });

/**
 * The single terminal writer: the retry signal, the result summary (with its
 * `telemetry`), the envelope callers parse, and terminal friction — so no
 * ending can forget one. Must be awaited: the CLI `process.exit`s as soon as
 * `main` resolves.
 */
async function emitTerminal({
  terminal,
  result,
  config,
  phaseTimer = UNTIMED,
  worker = NO_WORKER,
}) {
  phaseTimer.stamp(terminal);
  await recordCloseTelemetry({ terminal, result, config, ...worker });
  if (result) {
    emitTerseResult({
      label: 'STORY CLOSE RESULT',
      result,
      scope: result.storyId,
      summary: {
        storyId: result.storyId,
        action: result.action,
        reason: result.reason,
        prNumber: result.prNumber,
        status: terminal?.status,
      },
    });
  }
  emitTerminalEnvelope(terminal, { config });
  await emitTerminalFriction({ envelope: terminal, config });
}

/**
 * @param {number} storyId
 * @param {string} reason
 * @returns {{ storyId: number, standalone: true, action: 'noop', reason: string }}
 */
function noopResult(storyId, reason) {
  return { storyId, standalone: true, action: 'noop', reason };
}

/** Close reasons meaning nothing merged — superseded or abandoned. */
const UNLANDED_CLOSE_REASONS = new Set(['not_planned', 'duplicate']);

/**
 * Terminal for an already-closed Story. `not_planned` / `duplicate` mean
 * nothing merged, so it fails rather than reporting `landed` (which would
 * also unblock dependents); `completed` or null (GitHub's default) reads as
 * landed.
 */
async function alreadyClosedResult(
  storyId,
  stateReason = null,
  config,
  worker = NO_WORKER,
) {
  if (UNLANDED_CLOSE_REASONS.has(stateReason)) {
    progress(
      'NOOP',
      `Story #${storyId} is closed as not planned — nothing to land.`,
    );
    const result = noopResult(storyId, 'closed-not-planned');
    const terminal = buildTerminalEnvelope({
      storyId,
      status: 'failed',
      phase: 'init',
      failure: {
        reason:
          `Story #${storyId} is closed as not planned (superseded or abandoned) — ` +
          'there is nothing to land. Re-plan it as a new Story, or pass a Story that is still open.',
      },
      nextCommand: null,
      elapsedSeconds: 0,
    });
    await emitTerminal({ terminal, result, config, worker });
    return { success: false, result, terminal };
  }

  progress('NOOP', `Story #${storyId} is already closed. Nothing to do.`);
  const result = noopResult(storyId, 'already-closed');
  const terminal = buildTerminalEnvelope({
    storyId,
    status: 'landed',
    phase: 'done',
    nextCommand: null,
    elapsedSeconds: 0,
  });
  await emitTerminal({ terminal, result, config, worker });
  return { success: true, result, terminal };
}

/**
 * Reuses the classifier's fallback class: the vocabulary is pinned by the
 * terminal schema, so `reason` names the blocker instead.
 */
const PREFLIGHT_BLOCK_CLASS = 'api-race-other';

/**
 * Returned, not thrown: a classified block, not a crash (a throw surfaces as
 * `failed`). The next command is the same close.
 *
 * @param {{ storyId: number, preflight: { verdict: string, reason: string },
 *   config: object, startedAtMs: number }} args
 * @returns {Promise<{ success: false, result: object, terminal: object }>}
 */
async function preflightBlockedResult({
  storyId,
  preflight,
  config,
  startedAtMs,
  worker = NO_WORKER,
}) {
  const result = noopResult(storyId, `graphql-preflight-${preflight.verdict}`);
  const terminal = buildTerminalEnvelope({
    storyId,
    status: 'blocked',
    phase: 'init',
    blocked: {
      blockClass: PREFLIGHT_BLOCK_CLASS,
      reason: preflight.reason,
      frictionCommentId: null,
    },
    nextCommand: NEXT_COMMANDS.close(storyId),
    elapsedSeconds: elapsedSecondsSince(startedAtMs),
  });
  await emitTerminal({ terminal, result, config, worker });
  return { success: false, result, terminal };
}

/**
 * The split baselines gates, by name; only registered ones, never a phantom key.
 *
 * @param {Record<string, string>|null|undefined} validationGates
 * @returns {Record<string, string>}
 */
function baselinesEnvelopeGates(validationGates) {
  const registered = Object.values(BASELINES_GATE_NAMES);
  const out = {};
  for (const [name, outcome] of Object.entries(validationGates ?? {})) {
    if (registered.includes(name)) out[name] = outcome;
  }
  return out;
}

/**
 * @param {{ skipValidation?: boolean, skipSync?: boolean }} options
 * @param {Record<string, string>|null} validationGates
 * @param {object|null} reviewOverride
 * @returns {Record<string, string>}
 */
function closeEnvelopeGates(options, validationGates, reviewOverride) {
  return {
    validation: options.skipValidation ? 'skipped' : 'passed',
    ...baselinesEnvelopeGates(validationGates),
    baseSync: options.skipSync ? 'skipped' : 'passed',
    // The review did fail; the envelope records the human override.
    codeReview: reviewOverride ? 'overridden' : 'passed',
  };
}

/**
 * wrong-tree guard → base-sync → close-validation. Validation runs last so
 * the validated tree is the pushed tree (base-sync's merge commit included),
 * and a cheap conflict is found before the expensive gates.
 *
 * @param {object} ctx
 * @param {object} deps
 * @returns {Promise<{
 *   validationGates: Record<string, string>|null,
 *   lockWait: { waitedSeconds: number, expired: boolean }|null,
 *   suiteTimings: object|null,
 *   pending: boolean,
 * }>} `validationGates` is null when skipped; `pending` means a full-suite
 *   lock wait expired and the gates deferred.
 */
async function runPrePushPhases(ctx, deps) {
  const { options, worktreePath, baseBranch, storyBranch, storyId, setPhase } =
    ctx;
  const { cwd } = options;
  setPhase('wrong-tree-guard');
  await runWrongTreeGuardPhase({
    cwd,
    worktreePath,
    baseBranch,
    storyId,
    provider: deps.provider,
    progress,
    gitSpawn: deps.gitSpawn,
  });
  if (!options.skipSync) {
    setPhase('base-sync');
    await runBaseSyncPhase({
      cwd,
      worktreePath,
      baseBranch,
      baseConfirmed: ctx.baseConfirmed,
      storyBranch,
      storyId,
      provider: deps.provider,
      injectedSync: deps.sync,
      progress,
    });
  } else {
    progress('SYNC', '⏭ Skipped (--skip-sync).');
  }
  if (options.skipValidation) {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
    return {
      validationGates: null,
      lockWait: null,
      suiteTimings: null,
      pending: false,
    };
  }
  setPhase('close-validation');
  let validation;
  try {
    validation = await runCloseValidationPhase({
      cwd,
      worktreePath,
      config: deps.config,
      baseBranch,
      storyBranch,
      storyId,
      progress,
      runCloseValidation,
      buildDefaultGates,
      onPreGateStepsDone: () => {
        ctx.heldReview = startHeldReview({
          cwd,
          storyId,
          storyBranch,
          baseBranch,
          provider: deps.provider,
          runCodeReviewFn: deps.runCodeReview,
          gitSpawnFn: gitSpawn,
          progress,
          config: deps.config,
        });
      },
    });
  } catch (err) {
    discardHeldReview(ctx.heldReview, 'validation failed', progress);
    // The gate that died is all this run observed; the envelope claims no more.
    if (typeof err?.closeGate === 'string') {
      ctx.setObservedGates({ [err.closeGate]: 'failed' });
    }
    throw err;
  }
  const gates = validation?.gates ?? null;
  ctx.setObservedGates(gates);
  return {
    validationGates: gates,
    lockWait: validation?.lockWait ?? null,
    suiteTimings: validation?.suiteTimings ?? null,
    pending: validation?.pending === true,
  };
}

/**
 * An overridden Story proceeds; anything else emits friction, blocks, throws.
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {{ prUrl: string, prNumber: number|null, reviewOutcome: object }} pr
 * @returns {Promise<object>}
 */
async function resolveReviewHalt(
  ctx,
  deps,
  { prUrl, prNumber, reviewOutcome },
) {
  const { storyId } = ctx;
  const criticalCount = reviewOutcome.severity?.critical ?? 0;
  // Checked before the blocked transition: an overridden Story proceeds.
  if (ctx.options.overrideReviewBlock) {
    return await handleOverriddenReviewBlock({
      provider: deps.provider,
      storyId,
      prUrl,
      prNumber,
      criticalCount,
      criticalByProvider: reviewOutcome.criticalByProvider,
      reason: ctx.options.overrideReviewBlock,
      config: deps.config,
    });
  }
  await emitReviewBlockedFriction({
    storyId,
    prNumber,
    criticalCount,
    criticalByProvider: reviewOutcome.criticalByProvider,
    config: deps.config,
  });
  await handleCriticalReviewBlock({
    provider: deps.provider,
    storyId,
    prUrl,
    criticalCount,
  });
  throw new Error(
    `[single-story-close] Story-scope review reported ${criticalCount} critical blocker(s) on PR ${prUrl}. ` +
      'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/mandrel-deliver`. ' +
      'If you have reviewed a finding and judged it wrong, re-run with ' +
      '`--override-review-block "<reason>"` rather than merging by hand.',
  );
}

async function openAndReviewPr(ctx, deps) {
  const { options, worktreePath, story, storyId, storyBranch, baseBranch } =
    ctx;
  const { cwd } = options;
  ctx.setPhase('push');
  // Push from the worktree so `pre-push` measures the tree being sent; the
  // ref-based reads below resolve identically from the shared `.git`.
  pushStoryBranch({ cwd, worktreePath, storyBranch, gitSync, progress });
  ctx.setPhase('pull-request');
  const { url: prUrl, alreadyMerged } = await ensurePullRequestWith({
    cwd,
    storyId,
    storyTitle: story.title,
    storyBody: story.body,
    storyBranch,
    baseBranch,
    gh: deps.gh,
    progress,
  });
  const prNumber = parsePrNumber(prUrl);
  ctx.recordPrNumber(prNumber);
  // Already merged (landed between invocations): skip review and arm; confirm observes it.
  if (alreadyMerged) {
    discardHeldReview(ctx.heldReview, 'PR already merged', progress);
    return { prUrl, prNumber, alreadyMerged: true };
  }
  const reviewOutcome = await reviewAfterPrOpen({
    held: ctx.heldReview,
    cwd,
    storyId,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    provider: deps.provider,
    runCodeReviewFn: deps.runCodeReview,
    gitSpawnFn: gitSpawn,
    progress,
    setPhase: ctx.setPhase,
    pauseTimer: ctx.phaseTimer.pause,
    recordDuration: ctx.phaseTimer.record,
  });
  const reviewOverride = reviewOutcome.halted
    ? await resolveReviewHalt(ctx, deps, { prUrl, prNumber, reviewOutcome })
    : null;
  return { prUrl, prNumber, alreadyMerged: false, reviewOverride };
}

async function releaseLease({ storyId }, deps) {
  try {
    const outcome = await deps.releaseLease({
      provider: deps.provider,
      storyId,
      config: deps.config,
    });
    progress(
      'LEASE',
      outcome.released
        ? `🔓 Story #${storyId} lease released.`
        : `🔓 Story #${storyId} lease not released (${outcome.reason}).`,
    );
    return outcome.released;
  } catch (err) {
    progress(
      'LEASE',
      `⚠️ lease release failed (close continues): ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Release the lease best-effort before re-throwing a blocked-prone phase's
 * error verbatim. The lease has no TTL, so a stranded claim would refuse the
 * next operator who picks up the blocked Story.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function releaseLeaseOnBlock(run, ctx, deps) {
  try {
    return await run();
  } catch (err) {
    await releaseLease(ctx, deps);
    throw err;
  }
}

/**
 * Did this run OBSERVE the merge — confirmed, merged-but-flip-failed, or
 * direct-merged? Observation only, never intent.
 *
 * @param {{ waitOutcome?: object|null, directMerged?: boolean }} args
 * @returns {boolean}
 */
function deriveObservedMerge({ waitOutcome = null, directMerged = false }) {
  return (
    waitOutcome?.confirmed === true ||
    waitOutcome?.blockClass === MERGED_FLIP_FAILED_BLOCK_CLASS ||
    directMerged === true
  );
}

function closeResult({
  storyId,
  storyBranch,
  baseBranch,
  prUrl,
  prNumber,
  autoMergeEnabled,
  autoMergeReason,
  worktreeReaped = false,
  leaseReleased,
  localCleanupDeferred = false,
  directMerged = false,
  waitedForMerge = false,
  merged = false,
  landCompleted = merged,
}) {
  return {
    storyId,
    standalone: true,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    pushed: true,
    autoMergeEnabled,
    autoMergeReason,
    worktreeReaped,
    leaseReleased,
    // `gh`'s local branch delete failed while the remote merge/arm stood.
    localCleanupDeferred,
    // No native auto-merge, so the arm squash-merged directly.
    directMerged,
    waitedForMerge,
    merged,
    // Never from `waitedForMerge`; `merged` can be true without a completed land.
    note: deriveCloseNote({
      merged,
      directMerged,
      autoMergeEnabled,
      landCompleted,
    }),
  };
}

/**
 * An injected double wins, else the real one; an absent optional seam stays
 * `undefined` so its phase applies its own default.
 *
 * @param {{ cwd: string }} options
 * @param {object} injected
 * @returns {object}
 */
function resolveCloseDeps(options, injected) {
  const config = injected.injectedConfig || resolveConfig({ cwd: options.cwd });
  return {
    config,
    provider: injected.injectedProvider || createProvider(config),
    notify: injected.injectedNotify,
    sync: injected.injectedSync,
    runCodeReview: injected.injectedRunCodeReview ?? runCodeReviewDefault,
    gh: injected.injectedGh,
    gitSpawn: injected.injectedGitSpawn,
    releaseLease: injected.injectedReleaseLease ?? releaseStoryLease,
    graphqlProbe: injected.injectedGraphqlProbe,
  };
}

export async function runSingleStoryClose({
  storyId: storyIdParam,
  cwd: cwdParam,
  skipValidation: skipValidationParam,
  skipSync: skipSyncParam,
  noAutoMerge: noAutoMergeParam,
  waitForMerge: waitForMergeParam,
  noWaitForMerge: noWaitForMergeParam,
  maxWaitSeconds: maxWaitSecondsParam,
  mergeWatchMode: mergeWatchModeParam,
  rerunAdvisory: rerunAdvisoryParam,
  overrideReviewBlock: overrideReviewBlockParam,
  workerTokens: workerTokensParam,
  workerModel: workerModelParam,
  ...injected
} = {}) {
  const options = parseCloseOptions({
    storyIdParam,
    cwdParam,
    skipValidationParam,
    skipSyncParam,
    noAutoMergeParam,
    waitForMergeParam,
    noWaitForMergeParam,
    maxWaitSecondsParam,
    mergeWatchModeParam,
    rerunAdvisoryParam,
    overrideReviewBlockParam,
    workerTokensParam,
    workerModelParam,
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>] [--merge-watch-mode <sync|async>] [--rerun-advisory <n>] [--override-review-block <reason>] [--worker-tokens <n>] [--worker-model <model>]',
    );
  }

  // The runner keeps THROWING; it only tags the error with its phase and the
  // gates it observed (null until validation reports), and the CLI boundary
  // builds the `failed` envelope from those tags.
  let phase = 'init';
  let observedGates = null;
  const phaseTimer = createPhaseTimer();
  // Inert until the config resolves; no phase is entered before then.
  let storyProgress = { phase() {}, prNumber() {} };
  const setPhase = (next) => {
    phase = next;
    phaseTimer.enter(next);
    storyProgress.phase(next);
  };
  const setObservedGates = (gates) => {
    observedGates = gates;
  };
  try {
    const startedAtMs = Date.now();
    const deps = resolveCloseDeps(options, injected);
    storyProgress = createStoryProgress({
      storyId: options.storyId,
      stage: 'close',
      config: deps.config,
    });
    return await runClosePipeline(
      {
        options,
        setPhase,
        setObservedGates,
        phaseTimer,
        startedAtMs,
        recordPrNumber: storyProgress.prNumber,
      },
      deps,
    );
  } catch (err) {
    if (err && typeof err === 'object') {
      err.closePhaseDurations = phaseTimer.finish();
      if (!err.closePhase) err.closePhase = phase;
      if (!err.closeGates && observedGates) err.closeGates = observedGates;
    }
    throw err;
  }
}

/**
 * An already-merged PR skips the arm (`gh pr merge` would fail and block it).
 *
 * @param {object} args
 * @returns {Promise<{ autoMergeEnabled: boolean, autoMergeReason: string|null,
 *   localCleanupDeferred: boolean, directMerged: boolean }>}
 */
async function resolveAutoMergeOutcome({ alreadyMerged, ...phaseArgs }) {
  if (alreadyMerged) {
    return {
      autoMergeEnabled: true,
      autoMergeReason: null,
      localCleanupDeferred: false,
      directMerged: false,
      advisoryGate: null,
    };
  }
  return await runAutoMergePhase(phaseArgs);
}

/** One console line per non-landed wait ending, keyed by status. */
const WAIT_TERMINAL_LINES = Object.freeze({
  pending: (terminal, { storyId, prUrl }) => [
    'PENDING',
    `⏸  Story #${storyId}: PR ${prUrl} still in flight — resume with: ${terminal.nextCommand}`,
  ],
  failed: (terminal, { storyId, prUrl }) => [
    'FAILED',
    `🛑 Story #${storyId}: PR ${prUrl} did not land (${terminal.phase}): ` +
      `${terminal.failure?.reason}. Labels unchanged. Next: ${terminal.nextCommand}`,
  ],
  blocked: (terminal, { storyId, prUrl }) => [
    'BLOCKED',
    `🛑 Story #${storyId}: PR ${prUrl} did not land ` +
      `(blockClass=${terminal.blocked?.blockClass}). Story is at agent::blocked. ` +
      `Next: ${terminal.nextCommand}`,
  ],
  landed: (_terminal, { storyId, prUrl }) => [
    'DONE',
    `✅ Story #${storyId}: PR merged → ${prUrl}`,
  ],
});

/**
 * `pending` is not a failure: resumable, with its own CLI exit code.
 *
 * @param {{ status: string, nextCommand: string }} terminal
 * @param {{ storyId: number, prUrl: string|null }} ctx
 * @returns {void}
 */
function reportWaitTerminal(terminal, ctx) {
  const line =
    WAIT_TERMINAL_LINES[terminal.status] ?? WAIT_TERMINAL_LINES.blocked;
  progress(...line(terminal, ctx));
}

/**
 * Reaped only by the post-land tail, and only when it actually removed the
 * tree (a skipped reap reports ok with a detail).
 *
 * @param {object|null|undefined} tail
 * @returns {boolean}
 */
function tailReapedWorktree(tail) {
  return tail?.worktreeReap === true && !tail?.details?.worktreeReap;
}

/**
 * @param {object} prCtx
 * @param {object} deps
 * @returns {Promise<{ success: boolean, result: object, terminal: object }>}
 */
async function finishWithMergeWait(prCtx, deps) {
  deps.setPhase('confirm-merge');
  const waitOutcome = await runConfirmMergePhase({
    cwd: deps.cwd,
    worktreePath: prCtx.worktreePath,
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prNumber: prCtx.prNumber,
    prUrl: prCtx.prUrl,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    // Positive evidence for the re-arm rule: this close armed the PR.
    closeArmed: closeArmedPr(prCtx),
    advisoryGate: prCtx.advisoryGate,
    provider: deps.provider,
    config: prCtx.config,
    maxWaitSeconds: deps.maxWaitSeconds,
    mergeWatchMode: deps.mergeWatchMode,
    rerunAdvisory: deps.rerunAdvisory,
    progress,
    injectedGh: deps.injectedGh,
    injectedNotify: deps.injectedNotify,
    runPostLandTailFn: (args) => {
      deps.setPhase('post-land');
      return runPostLandTail(args);
    },
  });
  const terminal = terminalFromWaitOutcome({
    waitOutcome,
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prNumber: prCtx.prNumber,
    prUrl: prCtx.prUrl,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    gates: prCtx.gates,
    lockWait: prCtx.lockWait,
    suiteTimings: prCtx.suiteTimings,
    elapsedSeconds: elapsedSecondsSince(prCtx.startedAtMs),
  });
  const result = closeResult({
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prUrl: prCtx.prUrl,
    prNumber: prCtx.prNumber,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    worktreeReaped: tailReapedWorktree(waitOutcome.tail),
    // Released by the post-land tail only; any other ending keeps the claim.
    leaseReleased: waitOutcome.tail?.leaseRelease === true,
    localCleanupDeferred: prCtx.localCleanupDeferred,
    directMerged: prCtx.directMerged,
    waitedForMerge: true,
    merged: deriveObservedMerge({
      waitOutcome,
      directMerged: prCtx.directMerged,
    }),
    landCompleted: waitOutcome.confirmed === true,
  });
  await emitTerminal({
    terminal,
    result,
    config: prCtx.config,
    phaseTimer: prCtx.phaseTimer,
    worker: prCtx.worker,
  });
  reportWaitTerminal(terminal, { storyId: prCtx.storyId, prUrl: prCtx.prUrl });
  return { success: terminal.status === 'landed', result, terminal };
}

/**
 * The no-wait ending: a human owns the land, so it is `pending` with one
 * command to finish it. A direct merge by the arm is still observed.
 *
 * @param {object} prCtx
 * @param {string} waitForMergeReason
 * @returns {Promise<{ success: boolean, result: object, terminal: object }>}
 */
async function finishWithoutMergeWait(prCtx, waitForMergeReason) {
  const merged = deriveObservedMerge({ directMerged: prCtx.directMerged });
  const result = closeResult({
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prUrl: prCtx.prUrl,
    prNumber: prCtx.prNumber,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    leaseReleased: false,
    localCleanupDeferred: prCtx.localCleanupDeferred,
    directMerged: prCtx.directMerged,
    merged,
    // The flip, issue close and tail belong to `nextCommand`.
    landCompleted: false,
  });
  const terminal = buildTerminalEnvelope({
    storyId: prCtx.storyId,
    status: 'pending',
    phase: 'auto-merge',
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    pr: {
      number: prCtx.prNumber,
      url: prCtx.prUrl ?? null,
      state: merged ? 'MERGED' : 'OPEN',
      autoMergeEnabled: Boolean(prCtx.autoMergeEnabled),
      autoMergeReason: prCtx.autoMergeReason ?? null,
    },
    gates: prCtx.gates,
    lockWait: prCtx.lockWait,
    suiteTimings: prCtx.suiteTimings,
    nextCommand: NEXT_COMMANDS.confirmMerge(prCtx.storyId),
    elapsedSeconds: elapsedSecondsSince(prCtx.startedAtMs),
  });
  await emitTerminal({
    terminal,
    result,
    config: prCtx.config,
    phaseTimer: prCtx.phaseTimer,
    worker: prCtx.worker,
  });
  progress(
    'DONE',
    `✅ Story #${prCtx.storyId}: PR ready → ${prCtx.prUrl} (${waitForMergeReason})`,
  );
  return { success: true, result, terminal };
}

/**
 * A full-suite lock wait expired: `pending`, nothing pushed.
 *
 * @param {{ waitedSeconds: number, expired: boolean }|null} lockWait
 * @param {{ storyId: number, storyBranch: string, baseBranch: string,
 *   config: object, startedAtMs: number }} ctx
 * @returns {Promise<{ success: false, result: object, terminal: object }>}
 */
async function finishDeferred(
  lockWait,
  { config, startedAtMs, phaseTimer, worker, ...ids },
) {
  const { result, terminal, note } = lockWaitPending({
    ...ids,
    lockWait,
    elapsedSeconds: elapsedSecondsSince(startedAtMs),
  });
  await emitTerminal({ terminal, result, config, phaseTimer, worker });
  progress('PENDING', note);
  return { success: false, result, terminal };
}

/**
 * @param {number} startedAtMs
 * @returns {number}
 */
function elapsedSecondsSince(startedAtMs) {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

/**
 * @param {{ waitForMergeReason: string, autoMergeReason: string|null,
 *   storyId: number, waitForMergeExplicit?: boolean }} args
 * @returns {void}
 */
function reportOperatorMergeSkip({
  waitForMergeReason,
  autoMergeReason,
  storyId,
  waitForMergeExplicit,
}) {
  if (waitForMergeReason !== 'operator-merge') return;
  progress(
    'MERGE',
    `⏭  Not waiting for merge (${autoMergeReason}) — the operator owns this merge; ` +
      `Story #${storyId} rests at agent::closing.` +
      (waitForMergeExplicit === true
        ? ' --wait-merge cannot land a PR that was deliberately left un-armed.'
        : ''),
  );
}

async function loadStoryPhase(ctx, deps) {
  progress('INIT', `Closing standalone Story #${ctx.storyId}...`);
  ctx.story = await deps.provider.getTicket(ctx.storyId);
  if (ctx.story.state !== 'closed') return null;
  return await alreadyClosedResult(
    ctx.storyId,
    ctx.story.stateReason,
    deps.config,
    ctx.worker,
  );
}

/** One cheap GraphQL read here beats the gate chain plus a push. */
async function graphqlPreflightPhase(ctx, deps) {
  const preflight = await runGraphqlPreflight({
    storyId: ctx.storyId,
    provider: deps.provider,
    progress,
    ghFacade: deps.gh,
    probe: deps.graphqlProbe,
  });
  if (!preflight) return null;
  await releaseLease(ctx, deps);
  return await preflightBlockedResult({
    storyId: ctx.storyId,
    preflight,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    worker: ctx.worker,
  });
}

/**
 * The base the run was SEEDED from (init receipt); throws before any merge
 * when it disagrees with current config. Also the Story worktree every later
 * phase runs in — recreated before any git operation when it is missing.
 */
async function resolveBasePhase(ctx, deps) {
  const { values, confirmed } = await resolveRunScopedConfig({
    storyId: ctx.storyId,
    config: deps.config,
    progress,
  });
  ctx.baseBranch = values.baseBranch;
  ctx.baseConfirmed = confirmed;
  ctx.worktreePath = await resolveCloseWorktree(ctx, deps);
  return null;
}

/**
 * A surviving local ref, or a branch still on origin, may carry work no PR
 * holds yet. Only `ls-remote`'s "no such ref" (exit 2) proves the remote
 * branch gone — a read failure counts as surviving.
 */
function storyBranchSurvives(ctx) {
  const cwd = ctx.options.cwd;
  const ref = `refs/heads/${ctx.storyBranch}`;
  const local = gitSpawn(cwd, 'show-ref', '--verify', '--quiet', ref);
  if (local.status === 0) return true;
  const remote = gitSpawn(
    cwd,
    'ls-remote',
    '--exit-code',
    '--heads',
    'origin',
    ctx.storyBranch,
  );
  return remote.status !== 2;
}

/**
 * The Story's PR, when it already merged and nothing newer is in flight — a
 * re-run after the land, whose branch `--delete-branch` and a sweep removed.
 * An OPEN PR on the head wins (a re-delivery), as `ensurePullRequestWith`
 * decides, and a surviving branch means there may be work to deliver.
 * Any read failure reads as "not merged": the normal path then decides.
 *
 * @returns {Promise<{ prUrl: string, prNumber: number|null }|null>}
 */
async function findLandedPr(ctx, deps) {
  if (storyBranchSurvives(ctx)) return null;
  try {
    const rows = await (deps.gh ?? defaultGh).pr.list(
      ['--head', ctx.storyBranch, '--state', 'all'],
      ['url', 'state', 'mergedAt'],
    );
    const head = pickHeadPullRequest(rows);
    return head?.state === 'MERGED'
      ? { prUrl: head.url, prNumber: parsePrNumber(head.url) }
      : null;
  } catch {
    return null;
  }
}

/**
 * A missing worktree is recreated — unless the PR already merged, which
 * short-circuits to the confirm before any restore is attempted.
 */
async function resolveCloseWorktree(ctx, deps) {
  const cwd = ctx.options.cwd;
  const wtIsolation = deps.config.delivery?.worktreeIsolation;
  const missing =
    !existingWorktreePath({ cwd, wtIsolation, storyId: ctx.storyId }) &&
    resolveWorktreeEnabled({ config: deps.config });
  ctx.landedPr = missing ? await findLandedPr(ctx, deps) : null;
  if (ctx.landedPr) {
    ctx.recordPrNumber(ctx.landedPr.prNumber);
    return null;
  }
  return await resolveStoryWorktree({
    cwd,
    config: deps.config,
    storyId: ctx.storyId,
    storyBranch: ctx.storyBranch,
    progress,
    gitSpawn,
    WorktreeManager,
  });
}

/** A landed PR has nothing left to validate, push or open. */
function unlessLanded(phase, onLanded) {
  return (ctx, deps) => (ctx.landedPr ? onLanded(ctx) : phase(ctx, deps));
}

function landedPrePush(ctx) {
  progress(
    'INIT',
    `⏭  PR ${ctx.landedPr.prUrl} already merged — skipping validation, sync and push.`,
  );
  ctx.options = { ...ctx.options, skipValidation: true, skipSync: true };
  ctx.prePush = {
    validationGates: null,
    lockWait: null,
    suiteTimings: null,
    pending: false,
  };
  return null;
}

function landedPr(ctx) {
  ctx.pr = { ...ctx.landedPr, alreadyMerged: true, reviewOverride: null };
  return null;
}

async function prePushPhase(ctx, deps) {
  ctx.prePush = await releaseLeaseOnBlock(
    () => runPrePushPhases(ctx, deps),
    ctx,
    deps,
  );
  if (!ctx.prePush.pending) return null;
  discardHeldReview(ctx.heldReview, 'validation pending', progress);
  return await finishDeferred(ctx.prePush.lockWait, {
    storyId: ctx.storyId,
    storyBranch: ctx.storyBranch,
    baseBranch: ctx.baseBranch,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    phaseTimer: ctx.phaseTimer,
    worker: ctx.worker,
  });
}

async function openPrPhase(ctx, deps) {
  ctx.pr = await releaseLeaseOnBlock(
    () => openAndReviewPr(ctx, deps),
    ctx,
    deps,
  );
  return null;
}

/**
 * No lease release here: only the post-land tail releases it. The Story
 * worktree is still live at the arm, and that is safe: a `gh pr merge
 * --delete-branch` whose only failure is the LOCAL delete of a branch the
 * worktree holds is classified `localCleanupDeferred` (`LOCAL_CLEANUP_FAILURE`
 * in `phases/auto-merge.js`), and the tail reaps the worktree, then the ref.
 */
async function armPhase(ctx, deps) {
  ctx.setPhase('auto-merge');
  const ciDelivery = getCiDelivery(deps.config);
  const { prUrl, prNumber, alreadyMerged } = ctx.pr;
  ctx.arm = await resolveAutoMergeOutcome({
    alreadyMerged,
    cwd: ctx.options.cwd,
    prNumber,
    prUrl,
    noAutoMerge: ctx.options.noAutoMerge,
    autoMergePolicy: ciDelivery.autoMerge,
    blockOnAdvisoryFailure: ciDelivery.blockOnAdvisoryFailure,
    advisoryAllowlist: ciDelivery.advisoryAllowlist,
    gh: deps.gh,
    progress,
  });
  await flipLabelAndNotify({
    provider: deps.provider,
    notifyFn: deps.notify,
    storyId: ctx.storyId,
    story: ctx.story,
    prUrl,
    autoMergeEnabled: ctx.arm.autoMergeEnabled,
    autoMergeReason: ctx.arm.autoMergeReason,
    config: deps.config,
    progress,
  });
  return null;
}

/** Wait-for-merge needs the arm outcome, so it is resolved here. */
async function finishPhase(ctx, deps) {
  const { options, arm } = ctx;
  const { waitForMerge, reason: waitForMergeReason } = resolveWaitForMerge({
    waitForMergeExplicit: options.waitForMergeExplicit,
    noWaitForMerge: options.noWaitForMerge,
    config: deps.config,
    autoMergeReason: arm.autoMergeReason,
  });
  reportOperatorMergeSkip({
    waitForMergeReason,
    autoMergeReason: arm.autoMergeReason,
    storyId: ctx.storyId,
    waitForMergeExplicit: options.waitForMergeExplicit,
  });
  const prCtx = {
    storyId: ctx.storyId,
    storyBranch: ctx.storyBranch,
    baseBranch: ctx.baseBranch,
    prNumber: ctx.pr.prNumber,
    prUrl: ctx.pr.prUrl,
    autoMergeEnabled: arm.autoMergeEnabled,
    autoMergeReason: arm.autoMergeReason,
    advisoryGate: arm.advisoryGate,
    worktreePath: ctx.worktreePath,
    localCleanupDeferred: arm.localCleanupDeferred,
    directMerged: arm.directMerged,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    phaseTimer: ctx.phaseTimer,
    worker: ctx.worker,
    lockWait: ctx.prePush.lockWait,
    suiteTimings: ctx.prePush.suiteTimings,
    gates: closeEnvelopeGates(
      options,
      ctx.prePush.validationGates,
      ctx.pr.reviewOverride,
    ),
  };
  if (!waitForMerge) {
    return await finishWithoutMergeWait(prCtx, waitForMergeReason);
  }
  return await finishWithMergeWait(prCtx, {
    cwd: options.cwd,
    provider: deps.provider,
    maxWaitSeconds: options.maxWaitSeconds,
    mergeWatchMode: options.mergeWatchMode,
    rerunAdvisory: options.rerunAdvisory,
    setPhase: ctx.setPhase,
    injectedGh: deps.gh,
    injectedNotify: deps.notify,
  });
}

/** Each phase extends the shared context; a non-null return ends the run. */
const CLOSE_PIPELINE = Object.freeze([
  loadStoryPhase,
  graphqlPreflightPhase,
  resolveBasePhase,
  unlessLanded(prePushPhase, landedPrePush),
  unlessLanded(openPrPhase, landedPr),
  armPhase,
  finishPhase,
]);

/**
 * @param {object} run
 * @param {object} deps
 * @returns {Promise<{ success: boolean, result: object, terminal: object }>}
 */
async function runClosePipeline(run, deps) {
  const ctx = {
    ...run,
    storyId: run.options.storyId,
    storyBranch: getStoryBranch(run.options.storyId),
    worker: {
      workerTokens: resolveWorkerTokens(run.options.workerTokens),
      workerModel: resolveWorkerModel(run.options.workerModel),
    },
  };
  for (const phase of CLOSE_PIPELINE) {
    const ending = await phase(ctx, deps);
    if (ending) return ending;
  }
}
