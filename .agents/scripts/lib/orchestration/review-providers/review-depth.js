/**
 * review-providers/review-depth.js — the one depth → prompt-prose mapping the
 * LLM-backed providers share; model-agnostic, it says how thorough to be.
 *
 * @typedef {import('./types.js').ReviewDepth} ReviewDepth
 */

/**
 * @type {Readonly<Record<ReviewDepth, string>>}
 */
const DEPTH_DIRECTIVES = Object.freeze({
  light:
    'Review depth: LIGHT. Run a single pass focused on spec adherence over the ' +
    'changed surface — confirm the change matches its stated intent. Reduce the ' +
    'integration and quality sweeps to a quick scan for obvious breakage; do not ' +
    'exhaustively re-walk them.',
  standard:
    'Review depth: STANDARD. Cover all review pillars (spec adherence, ' +
    'integration, documentation/quality) at normal thoroughness.',
  deep:
    'Review depth: DEEP. Cover all review pillars at full thoroughness, then ' +
    'make a second adversarial pass over the diff specifically hunting for ' +
    'integration regressions and security-relevant edges before finalizing ' +
    'findings. Check every caller in the callers block against the new ' +
    'signature or shape.',
});

/**
 * Follows the depth directive on a Story's first review pass, so it leads with
 * a space; see `BUG_CLASS_RULE`.
 */
export const EXHAUSTIVE_DIRECTIVE =
  ' This is the first review of this Story: make it exhaustive. Enumerate ' +
  'every defect class you raise. For each class, sweep every changed file ' +
  'for every instance before returning, and report them all in that ' +
  "finding's `instances`. For an access-control, authorization or " +
  'role-narrowing class, check every read, write and response path the ' +
  'diff adds.';

/**
 * Anything unrecognised, including `undefined`, is `standard`.
 *
 * @param {unknown} depth
 * @returns {ReviewDepth}
 */
export function normalizeDepth(depth) {
  return depth === 'light' || depth === 'deep' ? depth : 'standard';
}

/**
 * Always non-empty and carrying a `Review depth:` marker.
 *
 * @param {ReviewDepth|undefined} depth
 * @returns {string}
 */
export function renderDepthDirective(depth) {
  return DEPTH_DIRECTIVES[normalizeDepth(depth)];
}

/**
 * `EXHAUSTIVE_DIRECTIVE` on a first pass; otherwise empty.
 *
 * @param {boolean|undefined} exhaustive
 * @returns {string}
 */
export function renderExhaustiveDirective(exhaustive) {
  return exhaustive ? EXHAUSTIVE_DIRECTIVE : '';
}
