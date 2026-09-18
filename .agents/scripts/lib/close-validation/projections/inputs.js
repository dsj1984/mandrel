// .agents/scripts/lib/close-validation/projections/inputs.js
/** Shared argument validator for the close-validation projections. */

/**
 * @typedef {Object} ProjectionInputs
 * @property {string} [cwd]
 * @property {string} [baseBranch]
 * @property {string} [storyBranch]
 * @property {string} [baselinePath]
 */

/**
 * @typedef {Object} ValidationOk
 * @property {true} ok
 * @property {Record<string, number>} [baseline] - present when `loadBaseline` was supplied.
 */

/**
 * @typedef {Object} ValidationFail
 * @property {false} ok
 * @property {'missing-cwd'|'missing-base-branch'|'missing-story-branch'|'missing-baseline-path'|'no-baseline'} reason
 */

/**
 * Pure. Without `loadBaseline` the baseline file itself is not checked.
 *
 * @param {ProjectionInputs} inputs
 * @param {{ loadBaseline?: (path: string) => Record<string, number>|null|undefined }} [opts]
 * @returns {ValidationOk | ValidationFail}
 */
export function validateProjectionInputs(inputs, opts = {}) {
  const { cwd, baseBranch, storyBranch, baselinePath } = inputs ?? {};
  if (!cwd) return { ok: false, reason: 'missing-cwd' };
  if (!baseBranch) return { ok: false, reason: 'missing-base-branch' };
  if (!storyBranch) return { ok: false, reason: 'missing-story-branch' };
  if (!baselinePath) return { ok: false, reason: 'missing-baseline-path' };

  const { loadBaseline } = opts;
  if (typeof loadBaseline === 'function') {
    const baseline = loadBaseline(baselinePath);
    if (!baseline || Object.keys(baseline).length === 0) {
      return { ok: false, reason: 'no-baseline' };
    }
    return { ok: true, baseline };
  }

  return { ok: true };
}

/** Reasons the projections collapse to `missing-args`. */
export const MISSING_ARG_REASONS = new Set([
  'missing-cwd',
  'missing-base-branch',
  'missing-story-branch',
  'missing-baseline-path',
]);
