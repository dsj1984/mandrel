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
  DONE: 'agent::done',
  BLOCKED: 'agent::blocked',
};

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
