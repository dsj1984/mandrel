/**
 * phases/close-validation.js — the close-validation gate chain for a Story.
 *
 * Gate output goes to an artifact sink (inline output once overflowed the
 * host's tool-result ceiling): a pass reports one digest line, a failure
 * replays its tail inline. Full-suite lock-wait lines are also teed to
 * `progress()` so a long wait doesn't read as a hang, and an expired wait
 * defers to `pending` rather than failing.
 * `lockWait` / `suiteTimings` come from the lock-event channel, never output.
 */

import {
  createLockEventChannel as defaultCreateLockEventChannel,
  summarizeLockEvents,
} from '../../../close-lock-events.js';
import { buildDefaultGates as defaultBuildDefaultGates } from '../../../close-validation/gates.js';
import { runCloseValidation as defaultRunCloseValidation } from '../../../close-validation/runner.js';
import { LOCK_WAIT_EXPIRED_EXIT_CODE } from '../../../full-suite-lock.js';
import { createGateLogSink as defaultCreateGateLogSink } from '../gate-log.js';
import { runPreGateSteps as defaultRunPreGateSteps } from './pre-gate-steps.js';

/**
 * Pre-gate self-heal steps, then the gates (throws on first failure). The
 * steps commit in the worktree before scoring, so the gates see their output.
 * `onPreGateStepsDone` (must not throw) runs once the tree is final.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   config: object,
 *   baseBranch: string,
 *   storyBranch?: string,
 *   storyId: number,
 *   progress: (tag: string, msg: string) => void,
 *   runCloseValidation?: typeof defaultRunCloseValidation,
 *   buildDefaultGates?: typeof defaultBuildDefaultGates,
 *   runPreGateSteps?: typeof defaultRunPreGateSteps,
 *   runScopedFormatAutofix?: Function,
 *   runBaselineUpwardWriteback?: Function,
 *   runContextBudgetWriteback?: Function,
 *   createGateLogSink?: typeof defaultCreateGateLogSink,
 *   createLockEventChannel?: typeof defaultCreateLockEventChannel,
 *   onPreGateStepsDone?: () => void,
 * }} args
 * @returns {Promise<{
 *   gates: Record<string, 'passed'|'skipped'>|null,
 *   lockWait: { waitedSeconds: number, expired: boolean, holder?: object }|null,
 *   suiteTimings: { lockWaitMs: number, hostWaitMs: number|null, testRunMs: number }|null,
 *   pending: boolean,
 * }>} `pending` (with `gates: null`) when a lock wait expired; any other
 *   failure throws with `err.closeGate` naming the gate.
 */
export async function runCloseValidationPhase({
  cwd,
  worktreePath,
  config,
  baseBranch,
  storyBranch,
  storyId,
  progress,
  runCloseValidation = defaultRunCloseValidation,
  buildDefaultGates = defaultBuildDefaultGates,
  runPreGateSteps = defaultRunPreGateSteps,
  runScopedFormatAutofix,
  runBaselineUpwardWriteback,
  runContextBudgetWriteback,
  createGateLogSink = defaultCreateGateLogSink,
  createLockEventChannel = defaultCreateLockEventChannel,
  onPreGateStepsDone,
}) {
  await prepareTree({
    runPreGateSteps,
    onPreGateStepsDone,
    stepArgs: {
      cwd,
      worktreePath,
      storyId,
      baseBranch,
      storyBranch,
      config,
      progress,
      runScopedFormatAutofix,
      runBaselineUpwardWriteback,
      runContextBudgetWriteback,
    },
  });
  // One sink for both `log` seams so nothing routes around the artifact.
  const gateLog = createGateLogSink({ storyId, config });
  const lockEvents = createLockEventChannel();
  const gateList = buildDefaultGates({
    config,
    baseBranch,
    cwd: worktreePath || cwd,
    log: gateLog.log,
    storyId,
    evidenceCwd: cwd,
  });
  const { validation, lockWait, suiteTimings } = await runGateChain({
    runCloseValidation,
    gateLog,
    lockEvents,
    progress,
    validationArgs: {
      cwd,
      worktreePath,
      gates: gateList,
      storyId,
      // Anchors the evidence cache on the Story id, so a re-close at an
      // unchanged HEAD skips already-passed gates.
      standalone: true,
      // Needed for the advisory baseline projections; absent, they're skipped.
      baseBranch,
      storyBranch,
      config,
    },
  });
  if (!validation.ok) {
    return settleFailedValidation({ validation, lockWait, gateLog, progress });
  }
  progress('VALIDATE', `✅ All gates passed. ${gateLog.digest()}`);
  return {
    gates: gateOutcomes(gateList, validation),
    lockWait,
    suiteTimings,
    pending: false,
  };
}

async function prepareTree({ runPreGateSteps, onPreGateStepsDone, stepArgs }) {
  await runPreGateSteps(stepArgs);
  onPreGateStepsDone?.();
  const { baseBranch, worktreePath, progress } = stepArgs;
  progress(
    'VALIDATE',
    `Running close-validation gates against baseline ${baseBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
  );
}

async function runGateChain({
  runCloseValidation,
  gateLog,
  lockEvents,
  progress,
  validationArgs,
}) {
  let validation;
  let events;
  try {
    validation = await runCloseValidation({
      ...validationArgs,
      log: teeLockLines({ sink: gateLog.log, progress }),
      lockEvents,
    });
  } finally {
    // The sink is async-buffered; settle it before anything reads it, on
    // the throw path too.
    await gateLog.flush();
    events = lockEvents.read();
    lockEvents.dispose();
  }
  return { validation, ...summarizeLockEvents(events) };
}

/**
 * Deferred on an expired lock wait → `pending`; otherwise throws.
 *
 * @param {{
 *   validation: { failed: Array<{ gate: { name: string, hint?: string }, status: number, cwd?: string }> },
 *   lockWait: { waitedSeconds: number, expired: boolean }|null,
 *   gateLog: { replay: () => void },
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {{ gates: null, lockWait: object, suiteTimings: null, pending: true }}
 */
function settleFailedValidation({ validation, lockWait, gateLog, progress }) {
  const [first] = validation.failed;
  const { gate, status, cwd: gateCwd } = first;
  if (isDeferredLockWait(first, lockWait)) {
    progress(
      'VALIDATE',
      `⏸ ${gate.name} deferred: the full-suite lock wait expired after ${lockWait.waitedSeconds}s. Nothing was spawned; close will report pending.`,
    );
    return { gates: null, lockWait, suiteTimings: null, pending: true };
  }
  gateLog.replay();
  const err = new Error(
    `[single-story-close] Gate failed: ${gate.name} (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
      (gate.hint ? ` ${gate.hint}` : ''),
  );
  err.closeGate = gate.name;
  throw err;
}

/**
 * Display only: no figure is read back from these lines.
 *
 * @param {{ sink: (m: string) => void, progress: (tag: string, msg: string) => void }} args
 * @returns {(line: string) => void}
 */
function teeLockLines({ sink, progress }) {
  return (line) => {
    sink(line);
    if (String(line).includes('[full-suite-lock]')) progress('LOCK', line);
  };
}

/**
 * Needs both the exit code and a recorded expiry — either alone is ambiguous.
 *
 * @param {{ status: number }|undefined} failure
 * @param {{ expired: boolean }|null} lockWait
 * @returns {boolean}
 */
function isDeferredLockWait(failure, lockWait) {
  return (
    failure?.status === LOCK_WAIT_EXPIRED_EXIT_CODE &&
    lockWait?.expired === true
  );
}

/**
 * A gate that did not run this invocation reports `skipped`, never `passed`.
 *
 * @param {Array<{ name: string }>} gateList
 * @param {{ skipped?: Array<{ gate: { name: string } }> }} validation
 * @returns {Record<string, 'passed'|'skipped'>}
 */
function gateOutcomes(gateList, validation) {
  const outcomes = {};
  for (const gate of gateList) outcomes[gate.name] = 'passed';
  for (const { gate } of validation.skipped ?? [])
    outcomes[gate.name] = 'skipped';
  return outcomes;
}
