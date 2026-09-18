/**
 * Single source of truth for GitHub label names — import these rather than
 * using string literals.
 */

export const AGENT_LABELS = {
  REVIEW_SPEC: 'agent::review-spec',
  READY: 'agent::ready',
  EXECUTING: 'agent::executing',
  // PR open, merge unconfirmed; a killed close stays here so deliver resumes.
  CLOSING: 'agent::closing',
  DONE: 'agent::done',
  BLOCKED: 'agent::blocked',
};

/** Absent transitions (and self-transitions) are invalid. */
export const VALID_TRANSITIONS = {
  'agent::review-spec': ['agent::ready', 'agent::blocked'],
  'agent::ready': ['agent::executing', 'agent::blocked'],
  'agent::executing': ['agent::closing', 'agent::done', 'agent::blocked'],
  'agent::closing': ['agent::done', 'agent::blocked'],
  'agent::blocked': [
    'agent::ready',
    'agent::executing',
    'agent::closing',
    'agent::done',
  ],
  // Terminal. An operator re-open removes the label, so its from-state is
  // `null`, not `done`.
  'agent::done': [],
};

/**
 * A `null` / `undefined` `fromState` is initial entry and permits any state.
 *
 * @param {string|null|undefined} fromState
 * @param {string} toState
 * @returns {boolean}
 */
export function isValidTransition(fromState, toState) {
  if (fromState == null) return Object.values(AGENT_LABELS).includes(toState);
  if (fromState === toState) return false;
  const allowed = VALID_TRANSITIONS[fromState];
  if (!allowed) return false;
  return allowed.includes(toState);
}

/**
 * `EPIC` is a pure container that never carries `agent::*`, keeping it out
 * of the ready list; linkage is parent→child only.
 */
export const TYPE_LABELS = {
  STORY: 'type::story',
  EPIC: 'type::epic',
};

export const STATUS_LABELS = {
  BLOCKED: 'status::blocked',
};

/** Waives the Epic body's `## Acceptance Table` section. */
export const ACCEPTANCE_LABELS = {
  N_A: 'acceptance::n-a',
};

export const ACCEPTANCE_NA = ACCEPTANCE_LABELS.N_A;

/** Mirror the ownership buckets in `lib/github/framework-repo.js`. */
export const META_LABELS = {
  FRAMEWORK_GAP: 'meta::framework-gap',
  CONSUMER_IMPROVEMENT: 'meta::consumer-improvement',
  PLATFORM_GAP: 'meta::platform-gap',
};

/** Metadata only — the runtime pause is `agent::blocked`. */
export const RISK_LABELS = {
  HIGH: 'risk::high',
};

/** Legacy waiver for the retired post-plan healthcheck; kept for old tickets. */
export const PLANNING_LABELS = {
  HEALTHCHECK_WAIVED: 'planning::healthcheck-waived',
};

/** Literal duplicated on purpose so a grep for name and value hits one line. */
export const PLANNING_HEALTHCHECK_WAIVED = 'planning::healthcheck-waived';

/**
 * `META`/`FRICTION` labels are minted on demand by the graduator (friction
 * names come from live telemetry), not by the bootstrap taxonomy.
 */
export const LABEL_COLORS = {
  TYPE: '#7057FF',
  RISK_HIGH: '#B60205',
  AGENT: '#0E8A16',
  STATUS_BLOCKED: '#D93F0B',
  ACCEPTANCE: '#FBCA04',
  PLANNING: '#FEF2C0',
  META: '#1D76DB',
  FRICTION: '#D4C5F9',
};
