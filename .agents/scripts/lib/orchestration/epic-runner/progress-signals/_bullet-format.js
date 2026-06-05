/**
 * Shared bullet-formatting helpers for progress-signal detectors.
 *
 * Both crap-drift and maintainability-drift produce component-level
 * regression bullets and need the same two pure utilities — hoisted here
 * so they are maintained in one place (Story #3631, refs #3631).
 */

/**
 * Comparator that sorts the wildcard component `'*'` before all named
 * components, with named components in locale order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function componentOrder(a, b) {
  if (a === '*') return -1;
  if (b === '*') return 1;
  return a.localeCompare(b);
}

/**
 * Formats a numeric gate value for display: integers render without a
 * decimal point; non-integers are fixed to two decimal places.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
