// .agents/scripts/lib/close-validation/projections/inputs.js
/**
 * inputs.js — shared input validator for close-validation projection helpers.
 *
 * Used by `projections/maintainability.js` (and any future projection that
 * shares the same `{ cwd, epicBranch, storyBranch, baselinePath }` argument
 * shape) to collapse the inline guard cascade into a single predicate that
 * returns a typed `reason` on failure.
 *
 * Pure function — no I/O, no side effects. Callers inject `loadBaseline`
 * when they need the predicate to also confirm the baseline file is non-
 * empty; omitting `loadBaseline` skips the baseline check (the predicate
 * still verifies the `baselinePath` argument is present).
 */

/**
 * @typedef {Object} ProjectionInputs
 * @property {string} [cwd]
 * @property {string} [epicBranch]
 * @property {string} [storyBranch]
 * @property {string} [baselinePath]
 */

/**
 * @typedef {Object} ValidationOk
 * @property {true} ok
 * @property {Record<string, number>} [baseline] - When `loadBaseline` is
 *   supplied, the parsed baseline map is forwarded so callers don't have to
 *   re-read the file.
 */

/**
 * @typedef {Object} ValidationFail
 * @property {false} ok
 * @property {'missing-cwd'|'missing-epic-branch'|'missing-story-branch'|'missing-baseline-path'|'no-baseline'} reason
 */

/**
 * Validate the standard projection-helper argument set.
 *
 * Reason branches (in order):
 *   - `missing-cwd`           — cwd is falsy
 *   - `missing-epic-branch`   — epicBranch is falsy
 *   - `missing-story-branch`  — storyBranch is falsy
 *   - `missing-baseline-path` — baselinePath is falsy
 *   - `no-baseline`           — loadBaseline returned null/undefined/empty
 *
 * The fine-grained `missing-*` variants are normalised to the historical
 * `missing-args` reason by `maintainability.js` so the existing public
 * contract of `projectMaintainabilityRegressions` is preserved byte-for-byte.
 *
 * @param {ProjectionInputs} inputs
 * @param {{ loadBaseline?: (path: string) => Record<string, number>|null|undefined }} [opts]
 * @returns {ValidationOk | ValidationFail}
 */
export function validateProjectionInputs(inputs, opts = {}) {
  const { cwd, epicBranch, storyBranch, baselinePath } = inputs ?? {};
  if (!cwd) return { ok: false, reason: 'missing-cwd' };
  if (!epicBranch) return { ok: false, reason: 'missing-epic-branch' };
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

/**
 * The set of reason values returned by `validateProjectionInputs` that
 * represent "one of the required arguments was missing". Used by
 * projection helpers to normalise to the historical `missing-args`
 * skipped-reason without enumerating each variant at the call site.
 */
export const MISSING_ARG_REASONS = new Set([
  'missing-cwd',
  'missing-epic-branch',
  'missing-story-branch',
  'missing-baseline-path',
]);
