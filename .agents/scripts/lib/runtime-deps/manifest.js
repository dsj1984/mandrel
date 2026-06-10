/**
 * runtime-deps/manifest — loader for the framework's vendored runtime-dep SSOT.
 *
 * `.agents/runtime-deps.json` is the single source of truth for the
 * third-party npm packages the framework scripts import at runtime
 * (Story #3432). It ships *inside* `.agents/` so it travels with the
 * `mandrel` package into consumer projects. This module is the only reader of that
 * file — the bootstrap seeder (`project-bootstrap.js`), the preflight guard
 * (`ensure-installed.js`), and the import-vs-manifest drift test all derive
 * their dependency lists from `loadRuntimeDepsManifest()` so there is exactly
 * one place the list lives.
 *
 * The loader stays on Node builtins only (`node:fs`, `node:path`,
 * `node:url`) so it can run inside the preflight guard *before* any
 * third-party package is imported — that is the whole point of the guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the vendored manifest. `HERE` is
 * `.agents/scripts/lib/runtime-deps/`; the manifest sits at the `.agents/`
 * root, three directories up.
 */
export const MANIFEST_PATH = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  'runtime-deps.json',
);

/**
 * @typedef {object} RuntimeDepsManifest
 * @property {Record<string,string>} dependencies        — required runtime
 *   packages (name → semver range). Fail-fast enforced by the preflight.
 * @property {Record<string,string>} optionalDependencies — packages imported
 *   behind graceful-degradation paths; declared but never preflight-blocked.
 * @property {string[]} required — `Object.keys(dependencies)`.
 * @property {string[]} optional — `Object.keys(optionalDependencies)`.
 * @property {Set<string>} declared — union of required + optional names.
 */

/**
 * Read, parse, and structurally validate the runtime-deps manifest.
 *
 * Throws a clear `Error` when the file is missing or malformed so the
 * drift test and bootstrap seeder fail loudly on a packaging regression,
 * rather than silently treating the dependency set as empty.
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
