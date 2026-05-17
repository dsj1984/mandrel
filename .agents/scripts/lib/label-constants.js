/**
 * Central source of truth for all GitHub label names used by the orchestrator.
 *
 * Every other module (label-taxonomy, dispatch-engine, story-close,
 * etc.) should import from here rather than using string literals. Renames
 * land in one place.
 */

export const AGENT_LABELS = {
  REVIEW_SPEC: 'agent::review-spec',
  READY: 'agent::ready',
  EXECUTING: 'agent::executing',
  // Story #2144 — intermediate state owned by `story-close.js`. A Story
  // flips to `agent::closing` after preflight validation succeeds and
  // before the merge into `epic/<id>` is attempted. It flips to
  // `agent::done` only after the post-merge pipeline confirms the merge
  // landed; if the close is killed mid-flight, the Story remains at
  // `agent::closing` so a `/story-execute --resume` can pick up at the
  // post-merge phase rather than re-running preflight. The label is the
  // distinguishing signal between "hung close" and "finished work".
  CLOSING: 'agent::closing',
  DONE: 'agent::done',
  BLOCKED: 'agent::blocked',
};

/**
 * Allowed state-machine transitions across `agent::*` labels.
 *
 * The validator is permissive in the directions that pre-Story #2144
 * lifecycles relied on (e.g. `executing → done` for Tasks, which never
 * route through the closing chokepoint) and restrictive on the post-
 * `closing` exits: once a ticket is at `agent::closing` it may only
 * advance to `done` (merge landed) or fall back to `blocked` (close
 * failed and the operator must intervene).
 *
 * Each key is a source label; each value is the set of permitted target
 * labels reachable in a single transition. Transitions absent from this
 * map MUST be treated as invalid by the validator. Self-transitions
 * (e.g. `executing → executing`) are not permitted.
 */
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
  // Terminal: no outbound transitions from done. (A ticket can be
  // reopened by the operator, which removes the label entirely; that
  // is not modelled as a transition because the from-state at re-open
  // is `null`, not `agent::done`.)
  'agent::done': [],
};

/**
 * Returns true when transitioning from `fromState` to `toState` is allowed
 * by {@link VALID_TRANSITIONS}. A `null` / `undefined` `fromState` is
 * treated as the initial-entry edge and permits any state — the writer
 * is establishing a state where there was none.
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

export const TYPE_LABELS = {
  EPIC: 'type::epic',
  FEATURE: 'type::feature',
  STORY: 'type::story',
  TASK: 'type::task',
};

export const STATUS_LABELS = {
  BLOCKED: 'status::blocked',
};

/**
 * Persona labels are derived at bootstrap time from `.agents/personas/*.md`
 * (see `label-taxonomy.js`), not hard-coded here — the persona file is the
 * source of truth, and ticket hydration resolves the label value to the
 * matching filename.
 */
export const PERSONA_LABEL_PREFIX = 'persona::';

export const CONTEXT_LABELS = {
  PRD: 'context::prd',
  TECH_SPEC: 'context::tech-spec',
  ACCEPTANCE_SPEC: 'context::acceptance-spec',
};

/** Convenience aliases so callers can reach the new constants by name without
 * indexing into CONTEXT_LABELS. Mirrors the export ergonomics used by other
 * consumers that import named constants (e.g. PERSONA_LABEL_PREFIX). */
export const CONTEXT_ACCEPTANCE_SPEC = CONTEXT_LABELS.ACCEPTANCE_SPEC;

/**
 * Acceptance-axis labels for opt-out signalling on Stories and Features that
 * intentionally have no acceptance-spec coverage. Separate namespace from
 * `context::` because it expresses absence rather than a linked context
 * ticket.
 */
export const ACCEPTANCE_LABELS = {
  N_A: 'acceptance::n-a',
};

export const ACCEPTANCE_NA = ACCEPTANCE_LABELS.N_A;

/** Palette for the taxonomy; consumed by label-taxonomy.js. */
export const LABEL_COLORS = {
  TYPE: '#7057FF',
  AGENT: '#0E8A16',
  STATUS_BLOCKED: '#D93F0B',
  PERSONA: '#C5DEF5',
  CONTEXT: '#D4C5F9',
  ACCEPTANCE: '#FBCA04',
};
