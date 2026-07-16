// lib/cli/version-helpers.js
/**
 * Shared semver-ish parse and compare helpers used by both
 * `lib/cli/update.js` and `lib/cli/registry.js`.
 *
 * Both files previously defined local copies of `parseVersion` and
 * `compareVersions`; this module is the single authoritative
 * implementation (Story #4048 B3 — multiplied helpers).
 *
 * `resolveConsumerPinVersion` (Story #4530) lives here for the same
 * no-mirror-copies reason rather than in either file directly: `update.js`
 * already imports `registry.js` (for the drift-check fallback), so a
 * function needed by both would otherwise force a two-way circular import
 * between them. This module is a dependency-free leaf both already import.
 *
 * Builtins only — this module is imported from both the CLI surface
 * (`lib/cli/`) and the doctor registry which runs before third-party
 * packages are guaranteed to be present.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/** The published package whose consumer pin is resolved below. */
const PACKAGE_NAME = 'mandrel';

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

/**
 * Read the consumer's declared `mandrel` dependency pin from
 * `<consumerRoot>/package.json` (checking `dependencies` then
 * `devDependencies`), stripping a leading `^`/`~` range operator to
 * recover a base semver for comparison against the registry's newest
 * published version.
 *
 * A base-version compare against the target is the right question here
 * regardless of what the full range technically already matches: the
 * declared pin is exactly what `npm install mandrel@<target>` (the
 * `mandrel update` `npm-update` step) moves, so comparing its base version
 * decides whether that step needs to run.
 *
 * Returns `null` — never throws — when there is no readable `package.json`,
 * no `mandrel` entry in either dependency block, or the declared value
 * isn't a plain exact/caret/tilde semver (a `workspace:`/`file:`/`git+`
 * specifier, `latest`, `*`, or a comparator range). Callers fall back to
 * resolving the actually-installed version in that case — see
 * `lib/cli/update.js#resolveCurrentVersionForUpdate` and
 * `lib/cli/registry.js`'s `pin-current` doctor check (both Story #4530),
 * which is also how a project with no `mandrel` dependency at all —
 * including mandrel's own repo, which carries no self-dependency —
 * degrades to a clean skip rather than a false failure.
 *
 * @param {string} consumerRoot
 * @param {typeof nodeFs} [fsImpl]
 * @returns {string | null}
 */
export function resolveConsumerPinVersion(consumerRoot, fsImpl = nodeFs) {
  let parsed;
  try {
    const raw = fsImpl.readFileSync(
      path.join(consumerRoot, 'package.json'),
      'utf8',
    );
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const declared =
    parsed?.dependencies?.[PACKAGE_NAME] ??
    parsed?.devDependencies?.[PACKAGE_NAME];
  if (typeof declared !== 'string') return null;
  const match = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    declared.trim(),
  );
  return match ? match[1] : null;
}
