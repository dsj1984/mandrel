/**
 * single-story-close/failed-terminal.js — the `failed` envelope a close
 * emits when a phase throws, so a crashed close still reports which phase
 * died and which gates had run.
 */

import { Logger } from '../../Logger.js';
import {
  buildTerminalEnvelope,
  NEXT_COMMANDS,
} from '../story-deliver-terminal.js';

/**
 * The phase order `setPhase` walks; it MUST track `runPrePushPhases`, since
 * it decides which gates had cleared when a later phase died.
 */
const PHASE_ORDER = Object.freeze([
  'init',
  'wrong-tree-guard',
  'base-sync',
  'close-validation',
  'push',
  'pull-request',
  'code-review',
  'auto-merge',
  'confirm-merge',
  'post-land',
  'done',
]);

const GATE_PHASES = Object.freeze([
  ['validation', 'close-validation'],
  ['baseSync', 'base-sync'],
  ['codeReview', 'code-review'],
]);

/**
 * Mirrors `BASELINES_GATE_NAMES` in `lib/close-validation/gates.js`. A local
 * copy, not an import, because close suites mock that module wholesale and a
 * named import would fail to link; a test pins the two lists equal.
 */
const BASELINES_ENTRY_NAMES = Object.freeze([
  'check-baselines',
  'check-baselines-independent',
  'check-baselines-coverage',
]);

/**
 * Baselines outcomes the run actually observed (`err.closeGates`) — reported,
 * never reconstructed, so a gate the run never registered cannot appear.
 *
 * @param {Record<string, string>|null|undefined} observedGates
 * @returns {Record<string, 'passed'|'failed'|'skipped'>}
 */
function baselinesGatesObserved(observedGates) {
  const out = {};
  for (const [name, outcome] of Object.entries(observedGates ?? {})) {
    if (BASELINES_ENTRY_NAMES.includes(name)) out[name] = outcome;
  }
  return out;
}

/**
 * Every gate's outcome, never omitted (a missing gate would read as passing);
 * an unreached or operator-skipped gate is `skipped`.
 *
 * @param {string} phase The phase the run died in.
 * @param {{ skipValidation?: boolean, skipSync?: boolean,
 *   observedGates?: Record<string, string>|null }} args
 * @returns {Record<string, 'passed'|'failed'|'skipped'>}
 */
export function gatesForFailedPhase(phase, args = {}) {
  const skipped = { validation: args.skipValidation, baseSync: args.skipSync };
  const failedAt = PHASE_ORDER.indexOf(phase);
  const gates = {};
  for (const [gate, gatePhase] of GATE_PHASES) {
    const at = PHASE_ORDER.indexOf(gatePhase);
    if (gatePhase === phase) gates[gate] = 'failed';
    else if (failedAt < 0 || at > failedAt) gates[gate] = 'skipped';
    else gates[gate] = skipped[gate] ? 'skipped' : 'passed';
  }
  return { ...gates, ...baselinesGatesObserved(args.observedGates) };
}

/**
 * Never throws: a build failure here must not replace the original error as
 * the run's reported cause, so it returns null and the caller rethrows.
 * `err.closePhase` and `err.closeGates` are tagged by the runner.
 *
 * @param {unknown} err
 * @param {{ storyId?: string|number, skipValidation?: boolean, skipSync?: boolean }} args
 * @returns {object|null} null when the story id is unknown or assembly failed.
 */
export function failedTerminalFor(err, args = {}) {
  const phase = err?.closePhase ?? 'init';
  const storyId = Number(args.storyId);
  if (!Number.isInteger(storyId) || storyId <= 0) return null;
  try {
    return buildTerminalEnvelope({
      storyId,
      status: 'failed',
      phase,
      gates: gatesForFailedPhase(phase, {
        ...args,
        observedGates: err?.closeGates ?? null,
      }),
      failure: { reason: String(err?.message ?? err) },
      nextCommand: NEXT_COMMANDS.recover(storyId),
      elapsedSeconds: 0,
      phaseDurations: err?.closePhaseDurations ?? undefined,
    });
  } catch (buildErr) {
    Logger.error(
      `[single-story-close] ⚠️ Could not assemble the failed terminal envelope: ${buildErr?.message ?? buildErr}. Reporting the original failure instead.`,
    );
    return null;
  }
}
