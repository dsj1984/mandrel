/**
 * Ignores fragment, query and trailing slash; `null` for no `/pull/` or a
 * non-positive number.
 *
 * @param {string|null|undefined} prUrl
 * @returns {number|null}
 */
export function parsePrNumberFromUrl(prUrl) {
  if (typeof prUrl !== 'string') return null;
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
