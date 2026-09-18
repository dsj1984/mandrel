// lib/cli/version-helpers.js
/**
 * Version parse/compare and consumer-pin helpers shared by `update.js` and
 * `registry.js`. A dependency-free, builtins-only leaf: `update.js` imports
 * `registry.js` (a cycle otherwise), and the doctor registry runs before
 * third-party packages are guaranteed present.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = 'mandrel';

/**
 * Missing or non-numeric segments coerce to 0.
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
 * `Array.sort` comparator contract.
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
 * @param {string} current
 * @param {string} target
 * @returns {boolean}
 */
export function crossesMajor(current, target) {
  return parseVersion(target)[0] > parseVersion(current)[0];
}

/**
 * npm caret/tilde/exact semantics (incl. 0.x caret), prereleases ignored —
 * the only ranges {@link resolveConsumerPinSpec} yields, so no `semver` dep.
 *
 * @param {string} version
 * @param {{ operator: '^' | '~' | '', version: string }} spec
 * @returns {boolean}
 */
export function satisfiesPinSpec(version, spec) {
  if (compareVersions(version, spec.version) < 0) return false;
  const [vMajor, vMinor] = parseVersion(version);
  const [pMajor, pMinor, pPatch] = parseVersion(spec.version);

  if (spec.operator === '~') {
    return vMajor === pMajor && vMinor === pMinor;
  }
  if (spec.operator === '^') {
    if (pMajor > 0) return vMajor === pMajor;
    if (pMinor > 0) return vMajor === 0 && vMinor === pMinor;
    // ^0.0.x pins the patch axis exactly.
    return compareVersions(version, `0.0.${pPatch}`) === 0;
  }
  return compareVersions(version, spec.version) === 0;
}

/**
 * The consumer's declared `mandrel` pin (dependencies, then devDependencies)
 * as operator + base version; the operator matters for in-range checks.
 * `null`, never a throw, for no readable manifest, no entry, or anything but
 * a plain exact/caret/tilde semver (`workspace:`, `latest`, ranges, …).
 *
 * @param {string} consumerRoot
 * @param {typeof nodeFs} [fsImpl]
 * @returns {{ operator: '^' | '~' | '', version: string } | null}
 */
export function resolveConsumerPinSpec(consumerRoot, fsImpl = nodeFs) {
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
  const match = /^([\^~]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    declared.trim(),
  );
  if (!match) return null;
  return {
    operator: /** @type {'^' | '~' | ''} */ (match[1]),
    version: match[2],
  };
}

/**
 * The pin's base version: what `npm-update` moves, so comparing it decides
 * whether that step runs whatever the range already matches.
 *
 * @param {string} consumerRoot
 * @param {typeof nodeFs} [fsImpl]
 * @returns {string | null}
 */
export function resolveConsumerPinVersion(consumerRoot, fsImpl = nodeFs) {
  return resolveConsumerPinSpec(consumerRoot, fsImpl)?.version ?? null;
}
