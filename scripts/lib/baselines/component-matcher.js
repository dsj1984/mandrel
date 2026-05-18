/**
 * component-matcher.js — shared helper for matching a row's key (path or
 * route) against a components-registry entry's `includes` prefix.
 *
 * Hoisted out of six baseline-kind modules (coverage, crap, lint,
 * maintainability, mutation, lighthouse) which all shipped byte-equivalent
 * copies of this predicate. See Story #2464.
 *
 * @param {{ includes?: string } | null | undefined} component
 *   A components-registry entry. Treated as non-matching when nullish or
 *   when `includes` is not a string.
 * @param {string} p
 *   The row's key field — `path` for code-shaped rows or `route` for
 *   lighthouse-shaped rows. The matcher is identity-equal or
 *   prefix-with-slash; callers normalize the row shape before invoking.
 * @returns {boolean}
 */
export function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}
