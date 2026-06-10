/**
 * review-providers/review-depth.js — Shared depth-prompt vocabulary for the
 * LLM-backed review providers.
 *
 * Story #3937 / #3938 — the depth lever (`light` / `standard` / `deep`,
 * resolved from judged risk AND diff width by `resolveDepth` in
 * `lib/orchestration/review-depth.js`) is threaded into every
 * provider's `runReview` input. LLM-backed providers (codex, security-review,
 * ultrareview) must render that lever into the prompt/instructions they emit so
 * the model actually changes its thoroughness; the native (mechanical) provider
 * documents in its own JSDoc why depth does not change its lint +
 * maintainability sweep. This module is the single home for the depth → prose
 * mapping so the three LLM providers share one wording rather than each
 * re-spelling the semantics (which would cross the duplication gate).
 *
 * The mapping is intentionally model-agnostic: it describes *how thorough* the
 * review should be, not which tool runs it. A provider appends
 * `renderDepthDirective(depth)` to its prompt to instruct the model.
 *
 * @typedef {import('./types.js').ReviewDepth} ReviewDepth
 */

/**
 * Canonical per-depth review directive sentences. Keyed by the canonical
 * `ReviewDepth` enum. Exported so tests and doc tooling can assert against the
 * exact wording rather than free-text matching.
 *
 * @type {Readonly<Record<ReviewDepth, string>>}
 */
export const DEPTH_DIRECTIVES = Object.freeze({
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
 * Normalize an arbitrary depth value to the canonical enum, defaulting to
 * `standard` for anything unrecognised (including `undefined` — providers may
 * receive an input without a depth from a caller that did not resolve one).
 *
 * Pure. Exported for testing.
 *
 * @param {unknown} depth
 * @returns {ReviewDepth}
 */
export function normalizeDepth(depth) {
  return depth === 'light' || depth === 'deep' ? depth : 'standard';
}

/**
 * Render the depth directive sentence(s) for a given depth value, ready to
 * append to a provider's prompt. Always returns a non-empty string carrying a
 * `Review depth:` marker so connectivity tests can assert the lever reached the
 * prompt regardless of which tier resolved.
 *
 * Pure. Exported for testing.
 *
 * @param {ReviewDepth|undefined} depth
 * @returns {string}
 */
export function renderDepthDirective(depth) {
  return DEPTH_DIRECTIVES[normalizeDepth(depth)];
}
