/**
 * Dependency-free so `crap-engine.js` and `crap-baseline-join.js` can share
 * these without an import cycle.
 */

/**
 * A row's `startLine` system. `original` is the readable file's (and
 * istanbul's). `transpiled` is kept only when the sourcemap cannot map the
 * line; such a row can neither join coverage nor compare against an
 * `original` baseline row.
 */
export const COORDINATE_ORIGINAL = 'original';
export const COORDINATE_TRANSPILED = 'transpiled';

/**
 * @param {number} cyclomatic
 * @param {number} coverage In [0, 1].
 * @returns {number}
 */
export function crapFormula(cyclomatic, coverage) {
  const c = Number(cyclomatic) || 0;
  const cov = Math.max(0, Math.min(1, Number(coverage) || 0));
  return c * c * (1 - cov) ** 3 + c;
}
