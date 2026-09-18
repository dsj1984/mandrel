/**
 * runtime-deps/ensure-installed — fail-fast guard for framework runtime deps.
 *
 * Runs on import, deliberately: ESM evaluates imports depth-first before any
 * module body, so only a side-effect import placed first in an entry point
 * can report a broken install before a sibling throws an opaque
 * `ERR_MODULE_NOT_FOUND`. A no-op on a healthy install. `optionalDependencies`
 * are not checked (they degrade gracefully). `MANDREL_SKIP_DEP_PREFLIGHT=1`
 * disables it.
 */

import { createRequire } from 'node:module';
import { resolveDependencyVersion } from '../dependency-version.js';
import {
  checkRuntimeDeps,
  formatMismatchedDepsMessage,
} from './dep-resolution.js';
import { loadRuntimeDepsManifest } from './manifest.js';
import { detectPackageManager, formatMissingDepsMessage } from './preflight.js';

// Resolves from this file upward — the same path the framework's imports take.
const frameworkRequire = createRequire(import.meta.url);

/**
 * @param {{
 *   requireResolve?: (specifier: string) => string,
 *   cwd?: string,
 *   stderr?: { write: (s: string) => void },
 *   exit?: (code: number) => void,
 *   manifest?: { required: string[], dependencies?: Record<string,string> },
 *   readVersion?: (name: string) => string | null,
 * }} [opts]
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function ensureRuntimeDepsInstalled(opts = {}) {
  const {
    requireResolve = (s) => frameworkRequire.resolve(s),
    cwd = process.cwd(),
    stderr = process.stderr,
    exit = process.exit,
    manifest = safeLoadManifest(),
    readVersion,
  } = opts;

  // An unreadable manifest is a packaging defect the drift test owns; never
  // kill a healthy process over it.
  if (!manifest) return { ok: true, missing: [] };

  const result = checkRuntimeDeps({
    required: manifest.required,
    resolve: requireResolve,
    ranges: manifest.dependencies ?? null,
    readVersion: readVersion ?? defaultReadVersion,
  });
  if (result.ok) return result;

  stderr.write(`${describeFailure(result, cwd)}\n`);
  exit(1);
  return result;
}

/**
 * Absence first: installing is the prerequisite for any version complaint.
 *
 * @param {{ missing: string[], mismatched: {name: string, required: string, resolved: string}[] }} result
 * @param {string} cwd
 * @returns {string}
 */
function describeFailure(result, cwd) {
  if (result.missing.length === 0) {
    return formatMismatchedDepsMessage(result.mismatched, { root: cwd });
  }
  const packageManager = detectPackageManager(cwd);
  return formatMissingDepsMessage(result.missing, {
    root: cwd,
    packageManager,
  });
}

/**
 * @param {string} name
 * @returns {string | null}
 */
function defaultReadVersion(name) {
  return resolveDependencyVersion(name, frameworkRequire);
}

/**
 * @returns {{ required: string[] } | null}
 */
function safeLoadManifest() {
  try {
    return loadRuntimeDepsManifest();
  } catch {
    return null;
  }
}

if (process.env.MANDREL_SKIP_DEP_PREFLIGHT !== '1') {
  ensureRuntimeDepsInstalled();
}
