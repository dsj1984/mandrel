/**
 * lib/orchestration/epic-deliver-close-tail.js — Phases C through F of
 * `/epic-deliver` (Story #1155 / Epic #1142).
 *
 * The merged runner's tail composes four phases sequentially with
 * checkpointed phase-granular resume:
 *
 *   - Phase C `close-validation` — `runWaveGate` + `runHierarchyGate`.
 *   - Phase D `code-review`      — `runCodeReview` (halts on critical).
 *   - Phase E `retro`            — `runRetro` (always-on, no opt-out).
 *   - Phase F `finalize`         — `runEpicDeliverFinalize`.
 *
 * Every phase reads / writes the `epic-run-state` checkpoint via
 * `Checkpointer.setPhase`. On entry the runner reads the checkpoint and
 * skips any phase whose index is below the recorded `phase` field — so a
 * mid-run crash during code-review resumes at code-review on the next
 * `/epic-deliver` invocation, not at the start of the wave loop.
 *
 * The runner halts and surfaces a clear error envelope when:
 *   - close-validation reports any non-zero exit (manifest stories open
 *     or hierarchy descendants open).
 *   - code-review reports a critical finding (`severity.critical > 0`).
 *   - retro fails to compose / post.
 *   - finalize halts (FF check failed, push failed, or `gh pr create`
 *     failed).
 *
 * The contract test `tests/workflows/epic-deliver.test.js` drives this
 * module directly — the slash-command markdown is the operator-facing
 * surface, not a separate orchestrator.
 */

import { runCodeReview as runCodeReviewDefault } from './code-review.js';
import {
  Checkpointer,
  DELIVER_PHASES,
  phaseIndex,
} from './epic-runner/checkpointer.js';
import { runRetro as runRetroDefault } from './retro-runner.js';

/**
 * Sequence of close-tail phases the runner walks. Excludes `prepare` and
 * `wave-loop` — those happen in the upstream slash-command flow before
 * the close-tail is invoked.
 */
export const CLOSE_TAIL_PHASES = Object.freeze([
  'close-validation',
  'code-review',
  'retro',
  'finalize',
]);

/**
 * Pure: decide whether `phase` should be skipped on resume. The
 * checkpoint's `phase` field stores the **next phase to run**, so any
 * phase strictly below it is already complete.
 */
export function shouldSkipPhase(checkpointPhase, candidate) {
  const cpIdx = phaseIndex(checkpointPhase);
  const candIdx = phaseIndex(candidate);
  if (cpIdx < 0) return false;
  if (candIdx < 0) return false;
  return candIdx < cpIdx;
}

/**
 * Compose Phase C — close-validation. Runs the wave gate and the
 * hierarchy gate against the current Epic state. Each gate is allowed
 * to short-circuit; the runner aggregates exit codes into a single
 * pass/fail envelope.
 *
 * `runWaveGateFn` and `runHierarchyGateFn` are injected so tests can
 * drive the close-tail without wiring the real provider through
 * `wave-gate.js` / `hierarchy-gate.js`.
 */
async function runCloseValidationPhase({
  epicId,
  runWaveGateFn,
  runHierarchyGateFn,
  logger,
}) {
  logger?.info?.(
    `[close-tail] Phase C: close-validation starting for Epic #${epicId}...`,
  );

  let waveGate;
  try {
    waveGate = await runWaveGateFn({ epicId });
  } catch (err) {
    return {
      ok: false,
      reason: 'wave-gate-error',
      detail: err?.message ?? String(err),
    };
  }
  if (waveGate?.exitCode && waveGate.exitCode !== 0) {
    return {
      ok: false,
      reason: 'wave-gate-failed',
      detail: waveGate?.message ?? `wave-gate exit ${waveGate.exitCode}`,
    };
  }

  let hierarchyGate;
  try {
    hierarchyGate = await runHierarchyGateFn({ epicId });
  } catch (err) {
    return {
      ok: false,
      reason: 'hierarchy-gate-error',
      detail: err?.message ?? String(err),
    };
  }
  if (hierarchyGate?.exitCode && hierarchyGate.exitCode !== 0) {
    return {
      ok: false,
      reason: 'hierarchy-gate-failed',
      detail:
        hierarchyGate?.message ??
        `hierarchy-gate exit ${hierarchyGate.exitCode}`,
    };
  }

  return { ok: true, waveGate, hierarchyGate };
}

/**
 * End-to-end close-tail driver. Runs the four phases in order, writing
 * the checkpoint's `phase` field after each successful phase advance, and
 * resuming from the checkpoint when called against an Epic that crashed
 * mid-tail on a prior invocation.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   checkpointer?: Checkpointer,
 *   runWaveGateFn?: ({ epicId: number }) => Promise<{ exitCode?: number, message?: string }>,
 *   runHierarchyGateFn?: ({ epicId: number }) => Promise<{ exitCode?: number, message?: string }>,
 *   runCodeReviewFn?: typeof runCodeReviewDefault,
 *   runRetroFn?: typeof runRetroDefault,
 *   runFinalizeFn?: ({ epicId: number, provider: object }) => Promise<{
 *     ffOk: boolean,
 *     pushed: boolean,
 *     prUrl: string|null,
 *     postedHandoff: boolean,
 *     blocker?: { reason: string, detail?: string },
 *   }>,
 * }} opts
 * @returns {Promise<{
 *   epicId: number,
 *   completed: boolean,
 *   resumedFrom: string,
 *   phasesRun: string[],
 *   phasesSkipped: string[],
 *   blocker?: { phase: string, reason: string, detail?: string },
 *   review?: object,
 *   retro?: object,
 *   finalize?: object,
 * }>}
 */
export async function runEpicDeliverCloseTail(opts = {}) {
  const {
    epicId,
    provider,
    logger,
    runWaveGateFn,
    runHierarchyGateFn,
    runCodeReviewFn = runCodeReviewDefault,
    runRetroFn = runRetroDefault,
    runFinalizeFn,
  } = opts;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverCloseTail: epicId is required (positive integer).',
    );
  }
  if (!provider) {
    throw new TypeError('runEpicDeliverCloseTail: provider is required.');
  }
  if (typeof runFinalizeFn !== 'function') {
    throw new TypeError(
      'runEpicDeliverCloseTail: runFinalizeFn is required (the close-tail does not import the finalize CLI directly).',
    );
  }

  const checkpointer =
    opts.checkpointer ?? new Checkpointer({ provider, epicId });

  // Read the checkpoint to determine the resume point. A missing
  // checkpoint means "start at close-validation" (the prepare + wave-loop
  // upstream phases own the checkpoint init lifecycle).
  const cpState = (await checkpointer.read()) ?? {};
  const resumePhase = cpState.phase ?? 'close-validation';
  const resumePhaseIdx = phaseIndex(resumePhase);

  logger?.info?.(
    `[close-tail] Resume point: phase=${resumePhase} (idx=${resumePhaseIdx})`,
  );

  const phasesRun = [];
  const phasesSkipped = [];
  const result = { epicId, completed: false, resumedFrom: resumePhase };

  // ---------- Phase C: close-validation ----------
  if (shouldSkipPhase(resumePhase, 'close-validation')) {
    phasesSkipped.push('close-validation');
  } else {
    const validation = await runCloseValidationPhase({
      epicId,
      runWaveGateFn,
      runHierarchyGateFn,
      logger,
    });
    if (!validation.ok) {
      result.blocker = {
        phase: 'close-validation',
        reason: validation.reason,
        detail: validation.detail,
      };
      result.phasesRun = phasesRun;
      result.phasesSkipped = phasesSkipped;
      return result;
    }
    phasesRun.push('close-validation');
    await checkpointer.setPhase('code-review');
  }

  // ---------- Phase D: code-review ----------
  if (shouldSkipPhase(resumePhase, 'code-review')) {
    phasesSkipped.push('code-review');
  } else {
    let review;
    try {
      review = await runCodeReviewFn({ epicId, provider, logger });
    } catch (err) {
      result.blocker = {
        phase: 'code-review',
        reason: 'code-review-error',
        detail: err?.message ?? String(err),
      };
      result.phasesRun = phasesRun;
      result.phasesSkipped = phasesSkipped;
      return result;
    }
    result.review = review;
    if (review?.halted) {
      result.blocker = {
        phase: 'code-review',
        reason: 'critical-findings',
        detail: review.blockerReason,
      };
      result.phasesRun = phasesRun;
      result.phasesSkipped = phasesSkipped;
      return result;
    }
    phasesRun.push('code-review');
    await checkpointer.setPhase('retro');
  }

  // ---------- Phase E: retro ----------
  if (shouldSkipPhase(resumePhase, 'retro')) {
    phasesSkipped.push('retro');
  } else {
    let retro;
    try {
      retro = await runRetroFn({ epicId, provider, logger });
    } catch (err) {
      result.blocker = {
        phase: 'retro',
        reason: 'retro-error',
        detail: err?.message ?? String(err),
      };
      result.phasesRun = phasesRun;
      result.phasesSkipped = phasesSkipped;
      return result;
    }
    result.retro = retro;
    phasesRun.push('retro');
    await checkpointer.setPhase('finalize');
  }

  // ---------- Phase F: finalize ----------
  if (shouldSkipPhase(resumePhase, 'finalize')) {
    phasesSkipped.push('finalize');
  } else {
    let finalize;
    try {
      finalize = await runFinalizeFn({ epicId, provider, logger });
    } catch (err) {
      result.blocker = {
        phase: 'finalize',
        reason: 'finalize-error',
        detail: err?.message ?? String(err),
      };
      result.phasesRun = phasesRun;
      result.phasesSkipped = phasesSkipped;
      return result;
    }
    result.finalize = finalize;
    if (finalize?.blocker) {
      result.blocker = {
        phase: 'finalize',
        reason: finalize.blocker.reason,
        detail: finalize.blocker.detail,
      };
      result.phasesRun = phasesRun;
      result.phasesSkipped = phasesSkipped;
      return result;
    }
    phasesRun.push('finalize');
    await checkpointer.setPhase('done');
  }

  result.completed = true;
  result.phasesRun = phasesRun;
  result.phasesSkipped = phasesSkipped;
  return result;
}

// Re-export phase list so consumers (the contract test, the slash-command
// markdown's documentation) have a single import target.
export { DELIVER_PHASES };
