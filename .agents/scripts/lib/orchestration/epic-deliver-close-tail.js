/* node:coverage ignore file -- orchestration phase composer; sequences wave-gate + hierarchy-gate + retro-runner + code-review against live state, tested via integration */

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
 * `epic-run-state-store.setPhase`. On entry the runner reads the
 * checkpoint and skips any phase whose index is below the recorded
 * `phase` field — so a mid-run crash during code-review resumes at
 * code-review on the next `/epic-deliver` invocation, not at the start
 * of the wave loop.
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
  DELIVER_PHASES,
  phaseIndex,
  read as readEpicRunState,
  setPhase as setEpicRunStatePhase,
} from './epic-run-state-store.js';
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

  const waveGate = await invokeGate(runWaveGateFn, { epicId }, 'wave-gate');
  if (!waveGate.ok) return waveGate;

  const hierarchyGate = await invokeGate(
    runHierarchyGateFn,
    { epicId },
    'hierarchy-gate',
  );
  if (!hierarchyGate.ok) return hierarchyGate;

  return {
    ok: true,
    waveGate: waveGate.value,
    hierarchyGate: hierarchyGate.value,
  };
}

/**
 * Run a single gate (wave-gate or hierarchy-gate) and normalize its
 * outcome into an `{ ok, value? , reason?, detail? }` envelope. Encapsulates
 * the try/catch + non-zero-exit check that both gates share.
 */
async function invokeGate(fn, args, label) {
  let result;
  try {
    result = await fn(args);
  } catch (err) {
    return { ok: false, reason: `${label}-error`, detail: messageOf(err) };
  }
  if (result?.exitCode && result.exitCode !== 0) {
    return {
      ok: false,
      reason: `${label}-failed`,
      detail: result?.message ?? `${label} exit ${result.exitCode}`,
    };
  }
  return { ok: true, value: result };
}

/**
 * Extract an error-ish into a flat string. Centralized so every phase
 * blocker carries an identical shape.
 */
function messageOf(err) {
  return err?.message ?? String(err);
}

/**
 * Execute one resumable phase. Encapsulates the skip-on-resume check,
 * the try/catch around the phase body, the optional `onResult` post-hook
 * (used by phases that branch on the returned envelope — e.g. code-review
 * halts on critical findings, finalize halts on its own `blocker` field),
 * and the checkpoint advance to `nextPhase` on success.
 *
 * Returns `{ done: true }` if the phase ran to completion (or was
 * skipped), `{ done: false, blocker }` if the phase halted.
 */
async function runPhase({
  phase,
  nextPhase,
  resumePhase,
  body,
  onResult,
  errorReason,
  checkpointer,
  phasesRun,
  phasesSkipped,
}) {
  if (shouldSkipPhase(resumePhase, phase)) {
    phasesSkipped.push(phase);
    return { done: true };
  }
  let value;
  try {
    value = await body();
  } catch (err) {
    return {
      done: false,
      blocker: { phase, reason: errorReason, detail: messageOf(err) },
    };
  }
  if (onResult) {
    const verdict = onResult(value);
    if (verdict?.halt) {
      return {
        done: false,
        blocker: { phase, ...verdict.blocker },
        value,
      };
    }
  }
  phasesRun.push(phase);
  await checkpointer.setPhase(nextPhase);
  return { done: true, value };
}

/**
 * Assert that the runner has the inputs it needs. Throws TypeError on
 * any violation. Lifted out of the main function body so the orchestrator
 * stays close to a linear phase sequence.
 */
function assertCloseTailInputs({ epicId, provider, runFinalizeFn, bus }) {
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
  // Epic #2646 Story C (Task #2700) — `bus` is now a hard input. The
  // previous guarded `emitLifecycleSafe` helper that tolerated a null
  // bus is gone.
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError(
      'runEpicDeliverCloseTail: bus is required (object with emit()).',
    );
  }
}

/**
 * End-to-end close-tail driver. Runs the four phases in order, writing
 * the checkpoint's `phase` field after each successful phase advance, and
 * resuming from the checkpoint when called against an Epic that crashed
 * mid-tail on a prior invocation.
 *
 * Story #2250 / #2252 — when `opts.bus` is supplied the runner emits
 * the umbrella `epic.close.start` event before Phase C (close-validation)
 * starts and `epic.close.end` after Phase E (retro) settles. The
 * umbrella pair brackets the three sub-phase event pairs
 * (`close-validate.*`, `code-review.*`, `retro.*`) so the lifecycle
 * ledger shows the full sub-phase ordering with explicit durations.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   epicRunStateStore?: { read: () => Promise<object|null>, setPhase: (nextPhase: string) => Promise<object> },
 *   bus?: object|null,
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
    bus,
    runWaveGateFn,
    runHierarchyGateFn,
    runCodeReviewFn = runCodeReviewDefault,
    runRetroFn = runRetroDefault,
    runFinalizeFn,
  } = opts;

  assertCloseTailInputs({ epicId, provider, runFinalizeFn, bus });

  // The checkpoint surface is the function-based `epic-run-state-store`
  // module. The collaborator slot exposes a provider/epicId-pre-bound
  // bag so the inner `runPhase` helper calls `checkpointer.setPhase(
  // nextPhase)` directly. Tests inject a fake bag via
  // `opts.epicRunStateStore`.
  const checkpointer = opts.epicRunStateStore ?? {
    read: () => readEpicRunState({ provider, epicId }),
    setPhase: (nextPhase) =>
      setEpicRunStatePhase({ provider, epicId, nextPhase }),
  };

  // Read the checkpoint to determine the resume point. A missing
  // checkpoint means "start at close-validation" (the prepare + wave-loop
  // upstream phases own the checkpoint init lifecycle).
  const cpState = (await checkpointer.read()) ?? {};
  const resumePhase = cpState.phase ?? 'close-validation';
  logger?.info?.(
    `[close-tail] Resume point: phase=${resumePhase} (idx=${phaseIndex(resumePhase)})`,
  );

  const phasesRun = [];
  const phasesSkipped = [];
  const result = { epicId, completed: false, resumedFrom: resumePhase };

  const phaseCtx = { resumePhase, checkpointer, phasesRun, phasesSkipped };

  // ---------- Phase C: close-validation ----------
  // Story #2250 — emit the umbrella `epic.close.start` immediately
  // before Phase C runs (when it is NOT being skipped on resume). The
  // umbrella event brackets the three sub-phase event pairs
  // (`close-validate.*`, `code-review.*`, `retro.*`). On a resume that
  // skips past close-validation, the original run's ledger already
  // carries `epic.close.start`; emitting again here would double-count.
  const shouldEmitEpicCloseStart = !shouldSkipPhase(
    resumePhase,
    'close-validation',
  );
  if (shouldEmitEpicCloseStart) {
    await bus.emit('epic.close.start', { epicId });
  }
  const c = await runPhase({
    ...phaseCtx,
    phase: 'close-validation',
    nextPhase: 'code-review',
    errorReason: 'close-validation-error',
    body: () =>
      runCloseValidationPhase({
        epicId,
        runWaveGateFn,
        runHierarchyGateFn,
        logger,
      }),
    onResult: (validation) =>
      validation.ok
        ? null
        : {
            halt: true,
            blocker: {
              reason: validation.reason,
              detail: validation.detail,
            },
          },
  });
  if (!c.done) {
    return finishResult(result, c.blocker, phasesRun, phasesSkipped);
  }

  // ---------- Phase D: code-review ----------
  const d = await runPhase({
    ...phaseCtx,
    phase: 'code-review',
    nextPhase: 'retro',
    errorReason: 'code-review-error',
    body: () => runCodeReviewFn({ epicId, provider, logger, bus }),
    onResult: (review) => {
      result.review = review;
      return review?.halted
        ? {
            halt: true,
            blocker: {
              reason: 'critical-findings',
              detail: review.blockerReason,
            },
          }
        : null;
    },
  });
  if (!d.done) {
    // Critical code-review findings are the single gating signal between
    // Phase D and Phase E: per Story #2167, the runner MUST mark the Epic
    // `agent::blocked`, post a friction comment summarizing the criticals,
    // and throw before retro starts (the throw replaces the previous
    // envelope-return so callers cannot silently advance past a halted
    // review per `orchestration-error-handling.md`).
    if (d.blocker?.reason === 'critical-findings') {
      await markEpicBlockedForCriticalReview({
        provider,
        epicId,
        review: result.review,
        detail: d.blocker.detail,
        logger,
        bus,
      });
      throw new Error(
        `[close-tail] Phase D halted: code-review reported critical findings — ${
          d.blocker.detail ?? 'critical-findings'
        }`,
      );
    }
    return finishResult(result, d.blocker, phasesRun, phasesSkipped);
  }

  // ---------- Phase E: retro ----------
  // Re-read the checkpoint so the retro scorecard reflects the latest
  // `manualInterventions` count. Out-of-band recovery (`epic-deliver-note-
  // intervention.js`) can append entries between the close-tail's prior
  // crash and this resume — Story #2289 makes that count visible in the
  // retro instead of silently dropping it. A read failure degrades to 0
  // so retro never blocks on checkpoint corruption.
  const retroRan = !shouldSkipPhase(resumePhase, 'retro');
  const e = await runPhase({
    ...phaseCtx,
    phase: 'retro',
    nextPhase: 'finalize',
    errorReason: 'retro-error',
    body: async () => {
      const interventionCount = await readInterventionCount(
        checkpointer,
        logger,
      );
      return runRetroFn({
        epicId,
        provider,
        logger,
        bus,
        manualInterventions: interventionCount,
      });
    },
    onResult: (retro) => {
      result.retro = retro;
      return null;
    },
  });
  if (!e.done) {
    return finishResult(result, e.blocker, phasesRun, phasesSkipped);
  }
  // Story #2252 — emit the umbrella `epic.close.end` after Phase E
  // settles. Symmetric with `epic.close.start`: when retro is skipped on
  // resume (because the original run finished retro), the umbrella end
  // is already in the prior run's ledger and we must not re-emit.
  if (retroRan) {
    await bus.emit('epic.close.end', { epicId });
  }

  // ---------- Phase F: finalize ----------
  const f = await runPhase({
    ...phaseCtx,
    phase: 'finalize',
    nextPhase: 'done',
    errorReason: 'finalize-error',
    body: () => runFinalizeFn({ epicId, provider, logger }),
    onResult: (finalize) => {
      result.finalize = finalize;
      return finalize?.blocker
        ? {
            halt: true,
            blocker: {
              reason: finalize.blocker.reason,
              detail: finalize.blocker.detail,
            },
          }
        : null;
    },
  });
  if (!f.done) {
    return finishResult(result, f.blocker, phasesRun, phasesSkipped);
  }

  result.completed = true;
  result.phasesRun = phasesRun;
  result.phasesSkipped = phasesSkipped;
  return result;
}

/**
 * Mark an Epic blocked because Phase D code-review surfaced critical
 * findings. After the Epic #2880 / Story #2898 hard cutover the
 * close-tail issues NO direct `provider.updateTicket` writes for any
 * phase state already produced by a listener — the label flip is
 * exclusively routed through `bus.emit('epic.blocked', ...)` so the
 * lifecycle `LabelTransitioner` listener owns the
 * `agent::executing` → `agent::blocked` transition. `assertCloseTailInputs`
 * guarantees `bus` is present before this code path runs.
 *
 * The rich friction comment (severity counts + halted-phase context)
 * is intentionally kept here: `StructuredCommentPoster` writes a
 * minimal `lifecycle-epic-blocked` marker off the same bus event,
 * while this helper writes the operator-facing `friction`-typed body
 * with severity totals. The two coexist by marker namespace and serve
 * different reader audiences (machine-readable vs. operator-readable).
 *
 * All side effects are best-effort — a failure is logged and
 * swallowed so the caller's `throw` is the operator-visible signal.
 */
async function markEpicBlockedForCriticalReview({
  provider,
  epicId,
  review,
  detail,
  logger,
  bus,
}) {
  try {
    // The `epic.blocked` payload schema accepts `reason` (required) and
    // an optional `sourceStoryId`. The operator-facing detail is carried
    // in the friction `postComment` below — not in the bus payload —
    // because the schema is strict (`additionalProperties: false`).
    await bus.emit('epic.blocked', { reason: 'critical-findings' });
  } catch (err) {
    logger?.warn?.(
      `[close-tail] epic.blocked emit failed (swallowed): ${messageOf(err)}`,
    );
  }

  const severity = review?.severity ?? {};
  const summary =
    `### 🚧 Epic blocked: critical code-review findings\n\n` +
    `Phase D (code-review) reported ${severity.critical ?? 0} critical, ` +
    `${severity.high ?? 0} high, ${severity.medium ?? 0} medium, ` +
    `${severity.suggestion ?? 0} suggestion finding(s).\n\n` +
    `Retro (Phase E) and finalize (Phase F) are halted until the criticals are remediated.` +
    (detail ? `\n\nDetail: ${detail}` : '');

  try {
    await provider.postComment(epicId, { type: 'friction', body: summary });
  } catch (err) {
    logger?.warn?.(
      `[close-tail] could not post friction comment on Epic #${epicId}: ${messageOf(err)}`,
    );
  }
}

/**
 * Attach the blocker + phase logs to the result envelope and return it.
 * Used by every halting branch in `runEpicDeliverCloseTail` so the
 * shape stays consistent.
 */
function finishResult(result, blocker, phasesRun, phasesSkipped) {
  result.blocker = blocker;
  result.phasesRun = phasesRun;
  result.phasesSkipped = phasesSkipped;
  return result;
}

/**
 * Read the checkpoint's `manualInterventions` array length, used by
 * Phase E to inflate the retro scorecard. A missing or corrupt checkpoint
 * collapses to 0 — the retro must never fail closed on observability data.
 */
async function readInterventionCount(checkpointer, logger) {
  try {
    const state = (await checkpointer.read()) ?? {};
    return Array.isArray(state.manualInterventions)
      ? state.manualInterventions.length
      : 0;
  } catch (err) {
    logger?.warn?.(
      `[close-tail] could not read manualInterventions for retro scorecard: ${messageOf(err)}`,
    );
    return 0;
  }
}

// Re-export phase list so consumers (the contract test, the slash-command
// markdown's documentation) have a single import target.
export { DELIVER_PHASES };
