/**
 * runtime-deps/manifest — the only reader of `.agents/runtime-deps.json`, the
 * SSOT for the framework's runtime npm packages. Builtins only, because the
 * preflight guard loads it before any third-party import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MANIFEST_PATH = path.resolve(HERE, '..', '..', '..', 'runtime-deps.json');

/**
 * @typedef {object} RuntimeDepsManifest
 * @property {Record<string,string>} dependencies        — required; preflight-enforced.
 * @property {Record<string,string>} optionalDependencies — graceful-degradation
 *   imports; never preflight-blocked.
 * @property {string[]} required
 * @property {string[]} optional
 * @property {Set<string>} declared — union of required + optional names.
 */

/**
 * Throws on a missing or malformed file rather than yielding an empty set,
 * so a packaging regression fails loudly.
 *
 * @param {string} [manifestPath=MANIFEST_PATH]
 * @returns {RuntimeDepsManifest}
 */
export function loadRuntimeDepsManifest(manifestPath = MANIFEST_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(
      `runtime-deps manifest not found at ${manifestPath}: ${err?.message ?? err}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `runtime-deps manifest at ${manifestPath} is not valid JSON: ${err?.message ?? err}`,
    );
  }
  const dependencies = parsed.dependencies;
  if (!dependencies || typeof dependencies !== 'object') {
    throw new Error(
      `runtime-deps manifest at ${manifestPath} is missing a "dependencies" object`,
    );
  }
  const optionalDependencies =
    parsed.optionalDependencies &&
    typeof parsed.optionalDependencies === 'object'
      ? parsed.optionalDependencies
      : {};
  return {
    dependencies,
    optionalDependencies,
    required: Object.keys(dependencies),
    optional: Object.keys(optionalDependencies),
    declared: new Set([
      ...Object.keys(dependencies),
      ...Object.keys(optionalDependencies),
    ]),
  };
}
