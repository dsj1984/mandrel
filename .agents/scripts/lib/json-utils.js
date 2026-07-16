/**
 * json-utils.js — shared JSON-shape helpers.
 *
 * Hoisted out of five callers (`lib/baselines/writer.js`,
 * `lib/config/defaults.js`, `lib/signals/schema.js`) which
 * shipped functionally-equivalent copies of these predicates. See Story
 * #2464.
 *
 * The helpers are scoped to JSON-shaped data — numbers, strings, booleans,
 * null, arrays, and plain objects. They do not handle Dates, Maps, Sets,
 * RegExps, or class instances; callers either JSON-roundtrip their inputs
 * or only ever pass JSON-equivalent values (the on-disk baseline writer
 * and the config defaults module both fall in the second bucket).
 */

/**
 * Return true when `v` is a plain object (not null, not an array). Used
 * by readers and aggregators to defensively pre-flight record shapes.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Structural deep-equality for JSON-shaped data. Object key order is
 * ignored. Array order is significant. NaN compares unequal (matches
 * `===` semantics; callers must not pass NaN).
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
