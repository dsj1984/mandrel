/**
 * Identity or prefix-with-slash match of a row key against a component's
 * `includes`.
 *
 * @param {{ includes?: string } | null | undefined} component
 * @param {string} p Row key: `path`, or `route` for lighthouse.
 * @returns {boolean}
 */
export function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}
