import nodeFs from 'node:fs';
import path from 'node:path';
import {
  BASELINES_GATE_NAMES,
  buildDefaultGates,
} from '../../close-validation/gates.js';
import { runCloseValidation } from '../../close-validation/runner.js';
import { getCiDelivery } from '../../config/ci.js';
import { resolveConfig } from '../../config-resolver.js';
import { getStoryBranch, gitSpawn, gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import {
  emitReviewBlockedFriction,
  recordCloseTelemetry,
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
import { deriveCloseNote } from './close-note.js';
import { runAutoMergePhase } from './phases/auto-merge.js';
import { runBaseSyncPhase } from './phases/base-sync.js';
import { runCloseValidationPhase } from './phases/close-validation.js';
import { parsePrNumber } from './phases/code-review.js';
import { runConfirmMergePhase } from './phases/confirm-merge.js';
import { runGraphqlPreflight } from './phases/graphql-preflight.js';
import { lockWaitPending } from './phases/lock-wait-pending.js';
import { parseCloseOptions, resolveWaitForMerge } from './phases/options.js';
import { runPostLandTail } from './phases/post-land.js';
import { ensurePullRequestWith } from './phases/pull-request.js';
import { pushStoryBranch } from './phases/push.js';
import { handleCriticalReviewBlock } from './phases/review-block.js';
import { handleOverriddenReviewBlock } from './phases/review-override.js';
import { reapWorktreePhase } from './phases/worktree-reap.js';
import { runWrongTreeGuardPhase } from './phases/wrong-tree-guard.js';
import {
  discardHeldReview,
  reviewAfterPrOpen,
  startHeldReview,
} from './review-overlap.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Wall-clock seconds per named phase; each transition logs the phase it ends.
 * An untimed phase stops the clock; work that overlaps other phases (the
 * held review) `record`s its own wall time instead.
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
    enter(phase, { timed = true } = {}) {
      end();
      if (phase === 'init' || !timed) return;
      current = phase;
      since = nowMs();
    },
    record,
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
  workerTokens = null,
}) {
  phaseTimer.stamp(terminal);
  await recordCloseTelemetry({ terminal, result, config, workerTokens });
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

/**
 * Terminal for an already-closed Story. `not_planned` means nothing merged,
 * so it fails rather than reporting `landed` (which would also unblock
 * dependents); `completed` or null (GitHub's default) reads as landed.
 */
async function alreadyClosedResult(
  storyId,
  stateReason = null,
  config,
  workerTokens = null,
) {
  if (stateReason === 'not_planned') {
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
    await emitTerminal({ terminal, result, config, workerTokens });
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
  await emitTerminal({ terminal, result, config, workerTokens });
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
  workerTokens = null,
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
  await emitTerminal({ terminal, result, config, workerTokens });
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

function resolveWorktreePath({ cwd, config, storyId }) {
  const root = config.delivery?.worktreeIsolation?.root ?? '.worktrees';
  const candidate = path.resolve(cwd, root, `story-${storyId}`);
  return nodeFs.existsSync(candidate) ? candidate : null;
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
    return { validationGates: null, lockWait: null, pending: false };
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
      // The tree is final once the self-heal commits land: review it now.
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
  worktreeReaped,
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
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>] [--merge-watch-mode <sync|async>] [--rerun-advisory <n>] [--override-review-block <reason>] [--worker-tokens <n>]',
    );
  }

  // The runner keeps THROWING; it only tags the error with its phase and the
  // gates it observed (null until validation reports), and the CLI boundary
  // builds the `failed` envelope from those tags.
  let phase = 'init';
  let observedGates = null;
  const phaseTimer = createPhaseTimer();
  const setPhase = (next, opts) => {
    phase = next;
    phaseTimer.enter(next, opts);
  };
  const setObservedGates = (gates) => {
    observedGates = gates;
  };
  try {
    const startedAtMs = Date.now();
    return await runClosePipeline(
      { options, setPhase, setObservedGates, phaseTimer, startedAtMs },
      resolveCloseDeps(options, injected),
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

/**
 * @param {{ status: string, nextCommand: string, blocked?: {blockClass?: string} }} terminal
 * @param {{ storyId: number, prUrl: string|null }} ctx
 * @returns {void}
 */
function reportWaitTerminal(terminal, { storyId, prUrl }) {
  if (terminal.status === 'landed') {
    progress('DONE', `✅ Story #${storyId}: PR merged → ${prUrl}`);
    return;
  }
  if (terminal.status === 'pending') {
    // Not a failure: resumable, with its own CLI exit code.
    progress(
      'PENDING',
      `⏸  Story #${storyId}: PR ${prUrl} still in flight — resume with: ${terminal.nextCommand}`,
    );
    return;
  }
  progress(
    'BLOCKED',
    `🛑 Story #${storyId}: PR ${prUrl} did not land ` +
      `(blockClass=${terminal.blocked?.blockClass}). Story is at agent::blocked. ` +
      `Next: ${terminal.nextCommand}`,
  );
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
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prNumber: prCtx.prNumber,
    prUrl: prCtx.prUrl,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
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
    gates: prCtx.gates,
    lockWait: prCtx.lockWait,
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
    worktreeReaped: prCtx.worktreeReaped,
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
    workerTokens: prCtx.workerTokens,
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
    worktreeReaped: prCtx.worktreeReaped,
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
    },
    gates: prCtx.gates,
    lockWait: prCtx.lockWait,
    nextCommand: NEXT_COMMANDS.confirmMerge(prCtx.storyId),
    elapsedSeconds: elapsedSecondsSince(prCtx.startedAtMs),
  });
  await emitTerminal({
    terminal,
    result,
    config: prCtx.config,
    phaseTimer: prCtx.phaseTimer,
    workerTokens: prCtx.workerTokens,
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
  { config, startedAtMs, phaseTimer, workerTokens, ...ids },
) {
  const { result, terminal, note } = lockWaitPending({
    ...ids,
    lockWait,
    elapsedSeconds: elapsedSecondsSince(startedAtMs),
  });
  await emitTerminal({ terminal, result, config, phaseTimer, workerTokens });
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
    ctx.workerTokens,
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
    workerTokens: ctx.workerTokens,
  });
}

/**
 * The base the run was SEEDED from (init receipt); throws before any merge
 * when it disagrees with current config.
 */
async function resolveBasePhase(ctx, deps) {
  const { values, confirmed } = await resolveRunScopedConfig({
    storyId: ctx.storyId,
    config: deps.config,
    progress,
  });
  ctx.baseBranch = values.baseBranch;
  ctx.baseConfirmed = confirmed;
  ctx.worktreePath = resolveWorktreePath({
    cwd: ctx.options.cwd,
    config: deps.config,
    storyId: ctx.storyId,
  });
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
    workerTokens: ctx.workerTokens,
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
 * Reap BEFORE the arm: `gh pr merge --delete-branch` may merge at once and
 * then fail deleting a branch a live worktree holds, reading as a failed arm.
 * Safe — the work is pushed, and a dirty tree is still refused.
 */
async function reapWorktreePhaseStep(ctx, deps) {
  ctx.worktreeReaped = await reapWorktreePhase({
    cwd: ctx.options.cwd,
    storyId: ctx.storyId,
    worktreePath: ctx.worktreePath,
    wtIsolation: deps.config.delivery?.worktreeIsolation,
    progress,
    WorktreeManager,
  });
  return null;
}

/** No lease release here: only the post-land tail releases it. */
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
    worktreeReaped: ctx.worktreeReaped,
    localCleanupDeferred: arm.localCleanupDeferred,
    directMerged: arm.directMerged,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    phaseTimer: ctx.phaseTimer,
    workerTokens: ctx.workerTokens,
    lockWait: ctx.prePush.lockWait,
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
  prePushPhase,
  openPrPhase,
  reapWorktreePhaseStep,
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
    workerTokens: resolveWorkerTokens(run.options.workerTokens),
  };
  for (const phase of CLOSE_PIPELINE) {
    const ending = await phase(ctx, deps);
    if (ending) return ending;
  }
}
