/**
 * plan-router — given an Epic's current labels, decide which plan-phase CLI
 * should run next.
 *
 * Used by the local `/plan` wrapper (chains spec → decompose).
 *
 * The router is intentionally stateless. Callers feed the current label set
 * (a string array, usually from `provider.getEpic(id).labels`) and receive a
 * `{ phase, script, command }` descriptor; no I/O is performed.
 */

import { AGENT_LABELS } from '../../label-constants.js';

export const PLAN_PHASE_NAMES = Object.freeze({
  SPEC: 'spec',
  DECOMPOSE: 'decompose',
});

/**
 * Canonical descriptor for each planning phase. `script` is the repo-relative
 * path used by the local wrapper; `command` is the slash-command invocation
 * operators fire.
 *
 * Spec and Decompose are served by the unified `/plan` wrapper with a
 * `--phase` flag — the phase workflows themselves live at
 * `.agents/workflows/helpers/epic-plan-{spec,decompose}.md` and are not
 * directly invokable slash commands.
 *
 * Exported as `PLAN_PHASE_DESCRIPTORS` to make the CLI-routing role explicit
 * (it describes which wrapper script/slash-command serves each planning phase).
 */
export const PLAN_PHASE_DESCRIPTORS = Object.freeze({
  [PLAN_PHASE_NAMES.SPEC]: {
    phase: PLAN_PHASE_NAMES.SPEC,
    script: '.agents/scripts/epic-plan-spec.js',
    command: '/plan --phase spec',
    parkingLabel: AGENT_LABELS.REVIEW_SPEC,
  },
  [PLAN_PHASE_NAMES.DECOMPOSE]: {
    phase: PLAN_PHASE_NAMES.DECOMPOSE,
    script: '.agents/scripts/epic-plan-decompose.js',
    command: '/plan --phase decompose',
    parkingLabel: AGENT_LABELS.READY,
  },
});

/**
 * Given the Epic's current labels, pick the next plan phase to run in the
 * local `/plan` wrapper.
 *
 * Precedence:
 *   1. If the Epic already carries `agent::ready`, there is nothing left to
 *      do — return `null` (the wrapper surfaces a no-op message).
 *   2. If the Epic carries `agent::review-spec`, decomposition is the next
 *      step (the operator has finished review).
 *   3. Otherwise (fresh Epic), start with the spec phase.
 *
 * @param {string[]} labels Current labels on the Epic.
 * @returns {object|null} Phase descriptor or null when no more work remains.
 */
export function nextPhaseForEpic(labels = []) {
  const set = new Set(labels);
  if (set.has(AGENT_LABELS.READY)) return null;
  if (set.has(AGENT_LABELS.REVIEW_SPEC)) {
    return PLAN_PHASE_DESCRIPTORS[PLAN_PHASE_NAMES.DECOMPOSE];
  }
  return PLAN_PHASE_DESCRIPTORS[PLAN_PHASE_NAMES.SPEC];
}

/**
 * For a given current phase, return the next phase the local wrapper should
 * advance to. Used to chain spec → decompose after operator confirmation.
 *
 * @param {string} currentPhase One of `PLAN_PHASE_NAMES`.
 * @returns {object|null}
 */
export function advancePhase(currentPhase) {
  switch (currentPhase) {
    case PLAN_PHASE_NAMES.SPEC:
      return PLAN_PHASE_DESCRIPTORS[PLAN_PHASE_NAMES.DECOMPOSE];
    case PLAN_PHASE_NAMES.DECOMPOSE:
      return null;
    default:
      return null;
  }
}
