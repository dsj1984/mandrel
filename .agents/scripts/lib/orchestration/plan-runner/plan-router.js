/**
 * plan-router — given an Epic's current labels, decide which plan-phase CLI
 * should run next.
 *
 * Used by the local `/sprint-plan` wrapper (chains spec → decompose).
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
 * Spec and Decompose are served by the unified `/sprint-plan` wrapper with a
 * `--phase` flag — the phase workflows themselves live at
 * `.agents/workflows/helpers/sprint-plan-{spec,decompose}.md` and are not
 * directly invokable slash commands.
 *
 * Exported as `PLAN_PHASE_DESCRIPTORS` so it does not collide with the
 * phase-name enum `PLAN_PHASES` in `plan-checkpointer.js`.
 */
export const PLAN_PHASE_DESCRIPTORS = Object.freeze({
  [PLAN_PHASE_NAMES.SPEC]: {
    phase: PLAN_PHASE_NAMES.SPEC,
    script: '.agents/scripts/sprint-plan-spec.js',
    command: '/sprint-plan --phase spec',
    parkingLabel: AGENT_LABELS.REVIEW_SPEC,
  },
  [PLAN_PHASE_NAMES.DECOMPOSE]: {
    phase: PLAN_PHASE_NAMES.DECOMPOSE,
    script: '.agents/scripts/sprint-plan-decompose.js',
    command: '/sprint-plan --phase decompose',
    parkingLabel: AGENT_LABELS.READY,
  },
});

/**
 * Given the Epic's current labels, pick the next plan phase to run in the
 * local `/sprint-plan` wrapper.
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
 * Ctx-aware wrapper: given a `PlanRunnerContext` whose `phase` field is set,
 * return the descriptor for that phase (or `null` if unknown). Lets
 * sprint-plan-spec / decompose resolve their phase descriptor from the ctx
 * they already hold rather than passing `phase` strings around.
 */
export function descriptorForContext(ctx) {
  if (!ctx?.phase) return null;
  return PLAN_PHASE_DESCRIPTORS[ctx.phase] ?? null;
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
