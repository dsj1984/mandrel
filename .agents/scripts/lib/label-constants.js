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
  STORY: 'type::story',
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

/**
 * Acceptance-axis labels for opt-out signalling on Epics that
 * intentionally have no acceptance-table coverage. (Story #4324 retired
 * the `context::tech-spec` / `context::acceptance-spec` label classes —
 * planning content now lives as managed sections of the Epic body. This
 * waiver survives with unchanged meaning: it waives the Epic body's
 * `## Acceptance Table` section instead of a ticket.)
 */
export const ACCEPTANCE_LABELS = {
  N_A: 'acceptance::n-a',
};

export const ACCEPTANCE_NA = ACCEPTANCE_LABELS.N_A;

/**
 * Meta-axis labels for retrospective signal routing (Epic #2547 — feedback
 * loop). `meta::framework-gap` is applied to issues that surface a defect or
 * missing capability in the framework itself; `meta::consumer-improvement`
 * is applied to issues that surface improvements to a consumer project
 * (workflow tweaks, ergonomic asks, doc polish). The `/plan` Phase 0
 * fetcher (see `lib/feedback-loop/prior-feedback-fetcher.js`) reads open
 * issues carrying either label and surfaces them to the planner so retro
 * signals are routed into durable substrates rather than lost in chat.
 */
export const META_LABELS = {
  FRAMEWORK_GAP: 'meta::framework-gap',
  CONSUMER_IMPROVEMENT: 'meta::consumer-improvement',
};

/**
 * Planning-axis labels (Epic #2880 F7). Currently scoped to the
 * `planning::healthcheck-waived` operator-applied waiver, which is the
 * documented escape hatch for the `/plan` Phase 10 readiness
 * healthcheck (`epic-plan-healthcheck.js`). The persist half of
 * `epic-plan-decompose.js` refuses to flip an Epic to `agent::ready`
 * when the healthcheck returned `ok: false` unless this label is
 * present — see `.agents/docs/SDLC.md` § "`agent::ready` exit conditions"
 * for the full handoff contract.
 *
 * Future planning-axis waivers (one per failing exit condition) extend
 * this enum so consumers can reference them by symbol.
 */
export const PLANNING_LABELS = {
  HEALTHCHECK_WAIVED: 'planning::healthcheck-waived',
};

/**
 * Convenience named export so callers can reach the constant without
 * indexing into PLANNING_LABELS — mirrors the ergonomics used by
 * ACCEPTANCE_NA. The literal value is
 * duplicated here (rather than aliased through PLANNING_LABELS) so a
 * grep for `PLANNING_HEALTHCHECK_WAIVED.*planning::healthcheck-waived`
 * matches a single line — see Story #2921 Task #2933 AC #1.
 */
export const PLANNING_HEALTHCHECK_WAIVED = 'planning::healthcheck-waived';

/** Palette for the taxonomy; consumed by label-taxonomy.js. */
export const LABEL_COLORS = {
  TYPE: '#7057FF',
  AGENT: '#0E8A16',
  STATUS_BLOCKED: '#D93F0B',
  PERSONA: '#C5DEF5',
  ACCEPTANCE: '#FBCA04',
  PLANNING: '#FEF2C0',
};
