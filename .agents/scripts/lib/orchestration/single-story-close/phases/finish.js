import { Logger } from '../../../Logger.js';
import {
  buildTerminalEnvelope,
  NEXT_COMMANDS,
  terminalFromWaitOutcome,
} from '../../story-deliver-terminal.js';
import {
  closeResult,
  deriveObservedMerge,
  elapsedSecondsSince,
  emitTerminal,
} from '../result.js';
import { closeArmedPr, runAutoMergePhase } from './auto-merge.js';
import { lockWaitPending } from './lock-wait-pending.js';
import { runPostLandTail } from './post-land.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * An already-merged PR skips the arm (`gh pr merge` would fail and block it).
 *
 * @param {object} args
 * @returns {Promise<{ autoMergeEnabled: boolean, autoMergeReason: string|null,
 *   localCleanupDeferred: boolean, directMerged: boolean }>}
 */
export async function resolveAutoMergeOutcome({ alreadyMerged, ...phaseArgs }) {
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
export async function finishWithMergeWait(prCtx, deps) {
  deps.setPhase('confirm-merge');
  const waitOutcome = await deps.runConfirmMergePhase({
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
export async function finishWithoutMergeWait(prCtx, waitForMergeReason) {
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
export async function finishDeferred(
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
 * @param {{ waitForMergeReason: string, autoMergeReason: string|null,
 *   storyId: number, waitForMergeExplicit?: boolean }} args
 * @returns {void}
 */
export function reportOperatorMergeSkip({
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
