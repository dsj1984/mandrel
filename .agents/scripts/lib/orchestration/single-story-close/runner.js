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
import { parsePrNumber, runStoryScopeReview } from './phases/code-review.js';
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

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Wall-clock seconds per named phase; each transition logs the phase it ends.
 *
 * @param {() => number} [nowMs]
 */
function createPhaseTimer(nowMs = Date.now) {
  const durations = {};
  let current = null;
  let since = 0;
  const end = () => {
    if (current === null) return;
    const seconds = Math.round((nowMs() - since) / 100) / 10;
    durations[current] = (durations[current] ?? 0) + seconds;
    progress('TIMING', `⏱  ${current}: ${seconds}s`);
    current = null;
  };
  return {
    enter(phase) {
      end();
      if (phase === 'init') return;
      current = phase;
      since = nowMs();
    },
    finish() {
      end();
      return Object.keys(durations).length > 0 ? { ...durations } : null;
    },
  };
}

/**
 * The single terminal writer: the result summary, the envelope callers parse,
 * and terminal friction — so no ending can forget one. Must be awaited: the
 * CLI `process.exit`s as soon as `main` resolves.
 */
async function emitTerminal({ terminal, result, config, phaseTimer }) {
  const phaseDurations = phaseTimer?.finish();
  if (terminal && phaseDurations) terminal.phaseDurations = phaseDurations;
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
 * Terminal for an already-closed Story. `not_planned` means nothing merged,
 * so it fails rather than reporting `landed` (which would also unblock
 * dependents); `completed` or null (GitHub's default) reads as landed.
 */
async function alreadyClosedResult(storyId, stateReason = null, config) {
  if (stateReason === 'not_planned') {
    progress(
      'NOOP',
      `Story #${storyId} is closed as not planned — nothing to land.`,
    );
    const result = {
      storyId,
      standalone: true,
      action: 'noop',
      reason: 'closed-not-planned',
    };
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
    await emitTerminal({ terminal, result, config });
    return { success: false, result, terminal };
  }

  progress('NOOP', `Story #${storyId} is already closed. Nothing to do.`);
  const result = {
    storyId,
    standalone: true,
    action: 'noop',
    reason: 'already-closed',
  };
  const terminal = buildTerminalEnvelope({
    storyId,
    status: 'landed',
    phase: 'done',
    nextCommand: null,
    elapsedSeconds: 0,
  });
  await emitTerminal({ terminal, result, config });
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
}) {
  const result = {
    storyId,
    standalone: true,
    action: 'noop',
    reason: `graphql-preflight-${preflight.verdict}`,
  };
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
  await emitTerminal({ terminal, result, config });
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
 * @returns {Promise<{
 *   validationGates: Record<string, string>|null,
 *   lockWait: { waitedSeconds: number, expired: boolean }|null,
 *   pending: boolean,
 * }>} `validationGates` is null when skipped; `pending` means a full-suite
 *   lock wait expired and the gates deferred.
 */
async function runPrePushPhases({
  cwd,
  worktreePath,
  config,
  baseBranch,
  baseConfirmed,
  storyBranch,
  storyId,
  provider,
  skipValidation,
  skipSync,
  injectedSync,
  injectedGitSpawn,
  setPhase = () => {},
  setObservedGates = () => {},
}) {
  setPhase('wrong-tree-guard');
  await runWrongTreeGuardPhase({
    cwd,
    worktreePath,
    baseBranch,
    storyId,
    provider,
    progress,
    gitSpawn: injectedGitSpawn,
  });
  if (!skipSync) {
    setPhase('base-sync');
    await runBaseSyncPhase({
      cwd,
      worktreePath,
      baseBranch,
      baseConfirmed,
      storyBranch,
      storyId,
      provider,
      injectedSync,
      progress,
    });
  } else {
    progress('SYNC', '⏭ Skipped (--skip-sync).');
  }
  if (skipValidation) {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
    return { validationGates: null, lockWait: null, pending: false };
  }
  setPhase('close-validation');
  let validation;
  try {
    validation = await runCloseValidationPhase({
      cwd,
      worktreePath,
      config,
      baseBranch,
      storyBranch,
      storyId,
      progress,
      runCloseValidation,
      buildDefaultGates,
    });
  } catch (err) {
    // The gate that died is all this run observed; the envelope claims no more.
    if (typeof err?.closeGate === 'string') {
      setObservedGates({ [err.closeGate]: 'failed' });
    }
    throw err;
  }
  const gates = validation?.gates ?? null;
  setObservedGates(gates);
  return {
    validationGates: gates,
    lockWait: validation?.lockWait ?? null,
    pending: validation?.pending === true,
  };
}

async function openAndReviewPr({
  cwd,
  worktreePath,
  story,
  storyId,
  storyBranch,
  baseBranch,
  provider,
  config,
  overrideReviewBlock,
  injectedGh,
  injectedRunCodeReview,
  setPhase = () => {},
}) {
  setPhase('push');
  // Push from the worktree so `pre-push` measures the tree being sent; the
  // ref-based reads below resolve identically from the shared `.git`.
  pushStoryBranch({ cwd, worktreePath, storyBranch, gitSync, progress });
  setPhase('pull-request');
  const { url: prUrl, alreadyMerged } = await ensurePullRequestWith({
    cwd,
    storyId,
    storyTitle: story.title,
    storyBody: story.body,
    storyBranch,
    baseBranch,
    gh: injectedGh,
    progress,
  });
  const prNumber = parsePrNumber(prUrl);
  // Already merged (landed between invocations): skip review and arm; confirm observes it.
  if (alreadyMerged) {
    return { prUrl, prNumber, alreadyMerged: true };
  }
  setPhase('code-review');
  const reviewOutcome = await runStoryScopeReview({
    cwd,
    storyId,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    provider,
    runCodeReviewFn: injectedRunCodeReview ?? runCodeReviewDefault,
    gitSpawnFn: gitSpawn,
    progress,
  });
  if (reviewOutcome.halted) {
    const criticalCount = reviewOutcome.severity?.critical ?? 0;
    // Checked before the blocked transition: an overridden Story proceeds.
    if (overrideReviewBlock) {
      const override = await handleOverriddenReviewBlock({
        provider,
        storyId,
        prUrl,
        prNumber,
        criticalCount,
        reason: overrideReviewBlock,
        config,
      });
      return {
        prUrl,
        prNumber,
        alreadyMerged: false,
        reviewOverride: override,
      };
    }
    await handleCriticalReviewBlock({
      provider,
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
  return { prUrl, prNumber, alreadyMerged: false, reviewOverride: null };
}

async function releaseLease({
  provider,
  storyId,
  config,
  injectedReleaseLease,
}) {
  try {
    const release = injectedReleaseLease ?? releaseStoryLease;
    const outcome = await release({ provider, storyId, config });
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
 * @param {{ provider: object, storyId: number, config: object, injectedReleaseLease?: Function }} leaseArgs
 * @returns {Promise<T>}
 */
async function releaseLeaseOnBlock(run, leaseArgs) {
  try {
    return await run();
  } catch (err) {
    await releaseLease(leaseArgs);
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
  injectedProvider,
  injectedConfig,
  injectedNotify,
  injectedSync,
  injectedRunCodeReview,
  injectedGh,
  injectedGitSpawn,
  injectedReleaseLease,
  injectedGraphqlProbe,
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
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>] [--merge-watch-mode <sync|async>] [--rerun-advisory <n>] [--override-review-block <reason>]',
    );
  }

  // The runner keeps THROWING; it only tags the error with its phase and the
  // gates it observed (null until validation reports), and the CLI boundary
  // builds the `failed` envelope from those tags.
  let phase = 'init';
  let observedGates = null;
  const phaseTimer = createPhaseTimer();
  const setPhase = (next) => {
    phase = next;
    phaseTimer.enter(next);
  };
  const setObservedGates = (gates) => {
    observedGates = gates;
  };
  try {
    return await runClosePipeline({
      options,
      setPhase,
      setObservedGates,
      phaseTimer,
      injectedProvider,
      injectedConfig,
      injectedNotify,
      injectedSync,
      injectedRunCodeReview,
      injectedGh,
      injectedGitSpawn,
      injectedReleaseLease,
      injectedGraphqlProbe,
    });
  } catch (err) {
    if (err && typeof err === 'object') {
      if (!err.closePhaseDurations) {
        err.closePhaseDurations = phaseTimer.finish();
      }
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
  { config, startedAtMs, phaseTimer, ...ids },
) {
  const { result, terminal, note } = lockWaitPending({
    ...ids,
    lockWait,
    elapsedSeconds: elapsedSecondsSince(startedAtMs),
  });
  await emitTerminal({ terminal, result, config, phaseTimer });
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

async function runClosePipeline({
  options,
  setPhase,
  setObservedGates,
  phaseTimer,
  injectedProvider,
  injectedConfig,
  injectedNotify,
  injectedSync,
  injectedRunCodeReview,
  injectedGh,
  injectedGitSpawn,
  injectedReleaseLease,
  injectedGraphqlProbe,
}) {
  const startedAtMs = Date.now();
  const config = injectedConfig || resolveConfig({ cwd: options.cwd });
  const provider = injectedProvider || createProvider(config);
  const storyBranch = getStoryBranch(options.storyId);

  progress('INIT', `Closing standalone Story #${options.storyId}...`);
  const story = await provider.getTicket(options.storyId);
  if (story.state === 'closed') {
    return await alreadyClosedResult(
      options.storyId,
      story.stateReason,
      config,
    );
  }

  const leaseArgs = {
    provider,
    storyId: options.storyId,
    config,
    injectedReleaseLease,
  };

  // `gh pr` needs GraphQL; one cheap read here beats the gate chain plus a push.
  const preflight = await runGraphqlPreflight({
    storyId: options.storyId,
    provider,
    progress,
    ghFacade: injectedGh,
    probe: injectedGraphqlProbe,
  });
  if (preflight) {
    await releaseLease(leaseArgs);
    return await preflightBlockedResult({
      storyId: options.storyId,
      preflight,
      config,
      startedAtMs,
    });
  }

  // The base the run was SEEDED from (init receipt); throws before any merge
  // when it disagrees with current config.
  const { values: runScoped, confirmed: baseConfirmed } =
    await resolveRunScopedConfig({
      storyId: options.storyId,
      config,
      progress,
    });
  const baseBranch = runScoped.baseBranch;

  const worktreePath = resolveWorktreePath({
    cwd: options.cwd,
    config,
    storyId: options.storyId,
  });
  const prePush = await releaseLeaseOnBlock(
    () =>
      runPrePushPhases({
        ...options,
        config,
        baseBranch,
        baseConfirmed,
        storyBranch,
        provider,
        worktreePath,
        injectedSync,
        injectedGitSpawn,
        setPhase,
        setObservedGates,
      }),
    leaseArgs,
  );
  if (prePush.pending) {
    return await finishDeferred(prePush.lockWait, {
      storyId: options.storyId,
      storyBranch,
      baseBranch,
      config,
      startedAtMs,
      phaseTimer,
    });
  }

  const { prUrl, prNumber, alreadyMerged, reviewOverride } =
    await releaseLeaseOnBlock(
      () =>
        openAndReviewPr({
          cwd: options.cwd,
          worktreePath,
          story,
          storyId: options.storyId,
          storyBranch,
          baseBranch,
          provider,
          config,
          overrideReviewBlock: options.overrideReviewBlock,
          injectedGh,
          injectedRunCodeReview,
          setPhase,
        }),
      leaseArgs,
    );
  // Reap BEFORE the arm: `gh pr merge --delete-branch` may merge at once and
  // then fail deleting a branch a live worktree holds, reading as a failed
  // arm. Safe — the work is pushed, and a dirty tree is still refused.
  const worktreeReaped = await reapWorktreePhase({
    cwd: options.cwd,
    storyId: options.storyId,
    worktreePath,
    wtIsolation: config.delivery?.worktreeIsolation,
    progress,
    WorktreeManager,
  });
  setPhase('auto-merge');
  const ciDelivery = getCiDelivery(config);
  const {
    autoMergeEnabled,
    autoMergeReason,
    localCleanupDeferred,
    directMerged,
    advisoryGate,
  } = await resolveAutoMergeOutcome({
    alreadyMerged,
    cwd: options.cwd,
    prNumber,
    prUrl,
    noAutoMerge: options.noAutoMerge,
    autoMergePolicy: ciDelivery.autoMerge,
    blockOnAdvisoryFailure: ciDelivery.blockOnAdvisoryFailure,
    advisoryAllowlist: ciDelivery.advisoryAllowlist,
    gh: injectedGh,
    progress,
  });
  await flipLabelAndNotify({
    provider,
    notifyFn: injectedNotify,
    storyId: options.storyId,
    story,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    config,
    progress,
  });
  // No lease release here: only the post-land tail (confirmed merge) releases
  // it; every non-merged ending keeps the claim while the PR is open.

  // Resolved now, not at parse time: it needs the config and the arm outcome
  // (an un-armed PR rests at `agent::closing` rather than waiting).
  const { waitForMerge, reason: waitForMergeReason } = resolveWaitForMerge({
    waitForMergeExplicit: options.waitForMergeExplicit,
    noWaitForMerge: options.noWaitForMerge,
    config,
    autoMergeReason,
  });
  reportOperatorMergeSkip({
    waitForMergeReason,
    autoMergeReason,
    storyId: options.storyId,
    waitForMergeExplicit: options.waitForMergeExplicit,
  });
  const prCtx = {
    storyId: options.storyId,
    storyBranch,
    baseBranch,
    prNumber,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    advisoryGate,
    worktreeReaped,
    localCleanupDeferred,
    directMerged,
    config,
    startedAtMs,
    phaseTimer,
    lockWait: prePush.lockWait,
    gates: closeEnvelopeGates(options, prePush.validationGates, reviewOverride),
  };

  if (waitForMerge) {
    return await finishWithMergeWait(prCtx, {
      cwd: options.cwd,
      provider,
      maxWaitSeconds: options.maxWaitSeconds,
      mergeWatchMode: options.mergeWatchMode,
      rerunAdvisory: options.rerunAdvisory,
      setPhase,
      injectedGh,
      injectedNotify,
    });
  }
  return await finishWithoutMergeWait(prCtx, waitForMergeReason);
}
