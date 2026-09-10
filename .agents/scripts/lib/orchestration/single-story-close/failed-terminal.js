/**
 * single-story-close/failed-terminal.js — the `failed` terminal a close
 * emits when a phase crashes, and the gate reconstruction it carries.
 *
 * Split out of `single-story-close.js` so the CLI entry stays an entry: it
 * parses args, dispatches the runner, and maps a terminal onto an exit code.
 * The reasoning about which gates had run by the time a phase died belongs
 * with the envelope it feeds, not in the file that owns process lifetime.
 *
 * The runner deliberately throws rather than returning a failure (a red gate
 * must not look like a return value), so without this the most common
 * non-happy ending — a failing close-validation gate — would emit **no
 * envelope at all**, exiting 1 with only a stderr line while the workflow
 * docs promise the agent a `failed` envelope naming the phase.
 */

import { Logger } from '../../Logger.js';
import {
  buildTerminalEnvelope,
  NEXT_COMMANDS,
} from '../story-deliver-terminal.js';

/**
 * The close pipeline's phase order, as `setPhase` walks it. Only used to
 * decide whether a gate had already run when a later phase died.
 */
const PHASE_ORDER = Object.freeze([
  'init',
  'wrong-tree-guard',
  // Story #5172 — base-sync now precedes close-validation, so the tree the
  // gates validate is the tree the push sends. The order here is not
  // decoration: it is how a failed terminal decides which gates had already
  // cleared, so it MUST track `runPrePushPhases`.
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

/** Each reported gate and the pipeline phase that decides it. */
const GATE_PHASES = Object.freeze([
  ['validation', 'close-validation'],
  ['baseSync', 'base-sync'],
  ['codeReview', 'code-review'],
]);

/**
 * The names the unified baselines gate can register under, mirrored from
 * `BASELINES_GATE_NAMES` in `lib/close-validation/gates.js` (Story #5172) —
 * all three, matching the projection the SUCCESS path applies in
 * `runner.js#baselinesEnvelopeGates`, so the two endings of one run cannot
 * key the same gate differently.
 *
 * Deliberately a local copy rather than an import: several close suites
 * replace that module wholesale via `t.mock.module`, and a named import here
 * would fail to link against a mock that does not re-export the constant —
 * turning an unrelated test's mock into a load error on the CLI's own entry
 * path. `tests/close-validation-gates-enum.test.js` pins the two lists
 * against each other so the copy cannot drift.
 */
const BASELINES_ENTRY_NAMES = Object.freeze([
  'check-baselines',
  'check-baselines-independent',
  'check-baselines-coverage',
]);

/**
 * Project the baselines entries out of the per-gate outcomes THIS run
 * observed (Story #5279).
 *
 * This used to RECONSTRUCT them: it inferred, from the phase the run died in
 * plus the name of the failing gate, what the two split entries "must have"
 * done — and it did so over a hardcoded pair, so every failed close reported
 * both split names whether or not the run had ever registered them. A repo
 * whose config resolves to the unsplit `check-baselines`, or to only one half
 * of the pair, got envelope keys for gates that did not exist; a run that
 * died at `init` got them too, reported as `skipped`, which reads as "the
 * gate was turned off" rather than "there was no such gate".
 *
 * Reporting instead of reconstructing removes the whole class: an outcome
 * appears only for a gate the run actually observed, and the runner tags
 * exactly that set onto the error (`err.closeGates`).
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
 * Report every gate's outcome for a run that died at `phase`.
 *
 * The schema's contract: "A gate the run skipped … reports `skipped` rather
 * than being omitted, so a missing gate is never mistaken for a passing one."
 * The previous shape named only the gate that died and omitted the rest
 * entirely — exactly the ambiguity the contract forbids.
 *
 * Reconstructed from the phase order, which is sound because the pipeline is
 * strictly sequential: reaching phase N means every gate before it completed.
 * A gate whose phase the run never reached is `skipped`; one the operator
 * turned off via `--skip-validation` / `--skip-sync` is `skipped` too (it did
 * not pass — it never ran).
 *
 * Story #5172 — the reported set also carries the baselines entries under
 * their own names, so a failed close says WHICH half of the baselines gate
 * breached instead of a single generic verdict. Story #5279 — those names
 * are REPORTED from `observedGates`, never reconstructed, so only a gate the
 * run registered can appear.
 *
 * @param {string} phase The phase the run died in.
 * @param {{ skipValidation?: boolean, skipSync?: boolean,
 *   observedGates?: Record<string, string>|null }} args
 *   Parsed CLI args, plus the per-gate outcomes the runner tagged onto the
 *   error.
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
 * Build the `failed` terminal for a phase that crashed. Every close
 * invocation emits exactly one envelope; this is the path that keeps that
 * true when a phase dies.
 *
 * `err.closePhase` is tagged by the runner's phase tracker.
 *
 * **Never throws.** This runs on the path that already has one failure in
 * hand, so a second failure here must not REPLACE the first: an
 * envelope-build error surfacing as the run's cause sends the operator to
 * diagnose the wrong thing entirely — a close whose PR had already merged
 * once reported a schema `ENOENT` as its fatal error, because the worktree
 * holding the script had been reaped mid-run. On failure this returns null
 * and the caller rethrows the original.
 *
 * `err.closeGates` — tagged by the runner — carries the per-gate outcomes the
 * run observed, which is what lets the reported gates name the baselines
 * entries that actually ran (Story #5172 / #5279) instead of a hardcoded pair.
 *
 * @param {unknown} err
 * @param {{ storyId?: string|number, skipValidation?: boolean, skipSync?: boolean }} args
 *   Parsed CLI args — the story id the envelope reports on, plus the skip
 *   flags `gatesForFailedPhase` needs.
 * @returns {object|null} A validated envelope, or null when even the story id
 *   is unknown (a usage error — there is nothing to report an envelope about)
 *   or the envelope itself could not be assembled.
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
    });
  } catch (buildErr) {
    Logger.error(
      `[single-story-close] ⚠️ Could not assemble the failed terminal envelope: ${buildErr?.message ?? buildErr}. Reporting the original failure instead.`,
    );
    return null;
  }
}
