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
    'findings.',
});

/**
 * Anything unrecognised, including `undefined`, is `standard`.
 *
 * @param {unknown} depth
 * @returns {ReviewDepth}
 */
function normalizeDepth(depth) {
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
