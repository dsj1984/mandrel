import { BASELINES_GATE_NAMES } from '../../close-validation/gates.js';
import { Logger } from '../../Logger.js';
import { recordCloseTelemetry } from '../../observability/close-telemetry.js';
import { emitTerminalFriction } from '../../observability/runtime-friction.js';
import { emitTerseResult } from '../../observability/terse-result.js';
import { MERGED_FLIP_FAILED_BLOCK_CLASS } from '../lifecycle/emit-merge-flip-failed.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  NEXT_COMMANDS,
} from '../story-deliver-terminal.js';
import { deriveCloseNote } from './close-note.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

const UNTIMED = Object.freeze({ stamp() {} });

/** No worker figures: an inline close, or an ending before they resolve. */
const NO_WORKER = Object.freeze({
  workerTokens: null,
  workerModel: null,
  workerEffort: null,
});

/**
 * The single terminal writer: the retry signal, the result summary (with its
 * `telemetry`), the envelope callers parse, and terminal friction — so no
 * ending can forget one. Must be awaited: the CLI `process.exit`s as soon as
 * `main` resolves.
 */
export async function emitTerminal({
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
export async function alreadyClosedResult(
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
export async function preflightBlockedResult({
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
 * `overridden` > `degraded` > `passed`: an override records the human
 * decision on a failed review; `degraded` says a review surface produced no
 * verdict (reported, not blocking — a secondary review does not gate merge).
 *
 * @param {object|null} reviewOverride
 * @param {boolean} [reviewDegraded]
 * @returns {'overridden'|'degraded'|'passed'}
 */
function codeReviewGate(reviewOverride, reviewDegraded) {
  if (reviewOverride) return 'overridden';
  return reviewDegraded ? 'degraded' : 'passed';
}

/**
 * @param {{ skipValidation?: boolean, skipSync?: boolean }} options
 * @param {Record<string, string>|null} validationGates
 * @param {object|null} reviewOverride
 * @param {boolean} [reviewDegraded]
 * @returns {Record<string, string>}
 */
export function closeEnvelopeGates(
  options,
  validationGates,
  reviewOverride,
  reviewDegraded,
) {
  return {
    validation: options.skipValidation ? 'skipped' : 'passed',
    ...baselinesEnvelopeGates(validationGates),
    baseSync: options.skipSync ? 'skipped' : 'passed',
    codeReview: codeReviewGate(reviewOverride, reviewDegraded),
  };
}

/**
 * Did this run OBSERVE the merge — confirmed, merged-but-flip-failed, or
 * direct-merged? Observation only, never intent.
 *
 * @param {{ waitOutcome?: object|null, directMerged?: boolean }} args
 * @returns {boolean}
 */
export function deriveObservedMerge({
  waitOutcome = null,
  directMerged = false,
}) {
  return (
    waitOutcome?.confirmed === true ||
    waitOutcome?.blockClass === MERGED_FLIP_FAILED_BLOCK_CLASS ||
    directMerged === true
  );
}

export function closeResult({
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
 * @param {number} startedAtMs
 * @returns {number}
 */
export function elapsedSecondsSince(startedAtMs) {
  return Math.round((Date.now() - startedAtMs) / 1000);
}
