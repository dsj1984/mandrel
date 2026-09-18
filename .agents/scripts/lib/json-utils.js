/**
 * json-utils.js — predicates for JSON-shaped data only (no Dates, Maps,
 * Sets, RegExps or class instances).
 */

/**
 * @param {unknown} v
 * @returns {boolean}
 */
export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Key order ignored, array order significant; NaN compares unequal.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}
