// lib/cli/version-helpers.js
/**
 * Shared semver-ish parse and compare helpers used by both
 * `lib/cli/update.js` and `lib/cli/registry.js`.
 *
 * Both files previously defined local copies of `parseVersion` and
 * `compareVersions`; this module is the single authoritative
 * implementation (Story #4048 B3 — multiplied helpers).
 *
 * Builtins only — this module is imported from both the CLI surface
 * (`lib/cli/`) and the doctor registry which runs before third-party
 * packages are guaranteed to be present.
 */

/**
 * Parse a dotted semver-ish string into a numeric tuple. Non-numeric or
 * missing segments coerce to 0 so a partial version still compares sanely.
 *
 * @param {string} version
 * @returns {[number, number, number]}
 */
export function parseVersion(version) {
  const [major, minor, patch] = String(version).split('.');
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

/**
 * Compare two version strings. Negative when `a < b`, zero when equal,
 * positive when `a > b` (the standard `Array.sort` comparator contract).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * True when `target`'s major axis is strictly greater than `current`'s —
 * the gated "crosses a major boundary" condition used by the update
 * orchestrator.
 *
 * @param {string} current
 * @param {string} target
 * @returns {boolean}
 */
export function crossesMajor(current, target) {
  return parseVersion(target)[0] > parseVersion(current)[0];
}
