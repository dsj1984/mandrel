/**
 * runtime-deps/ensure-installed — fail-fast guard for framework runtime deps.
 *
 * Importing this module runs the dependency-presence check as a side effect:
 * if any package in `.agents/runtime-deps.json`'s `dependencies` block cannot
 * be resolved from the framework's `node_modules` (i.e. the consumer's
 * install is missing, empty, or stale), it prints an actionable remediation
 * message and exits non-zero — *before* the entry point's heavier imports
 * reach the first `import 'ajv'` and throw an opaque `ERR_MODULE_NOT_FOUND`
 * (Story #3432).
 *
 * Why a side-effect-on-import (rather than a function the entry point calls):
 * ESM evaluates a module's imports in source order, depth-first, *before* the
 * module body runs. A function call in `main()` would therefore execute only
 * after the third-party-importing sibling modules had already been evaluated
 * (and already thrown). By making each target entry point's *first* import a
 * side-effect import of this module, the check runs first and short-circuits a
 * broken install with a clear message.
 *
 * The guard only ever exits when a *required* dependency is genuinely
 * missing. With a healthy install (CI, tests, normal runs) it is a no-op, so
 * it is safe for entry points imported by the test suite. `optionalDependencies`
 * are intentionally not checked — they sit behind graceful-degradation paths.
 *
 * Set `MANDREL_SKIP_DEP_PREFLIGHT=1` to disable the side effect (escape hatch
 * for tooling that imports an entry point in an environment that deliberately
 * lacks the framework deps).
 */

import { createRequire } from 'node:module';
import { resolveDependencyVersion } from '../dependency-version.js';
import {
  checkRuntimeDeps,
  formatMismatchedDepsMessage,
} from './dep-resolution.js';
import { loadRuntimeDepsManifest } from './manifest.js';
import { detectPackageManager, formatMissingDepsMessage } from './preflight.js';

// `require.resolve` bound to this module's location walks `node_modules`
// upward from `.agents/scripts/lib/runtime-deps/` to the consumer root —
// exactly the resolution path the framework's third-party imports follow.
const frameworkRequire = createRequire(import.meta.url);

/**
 * Run the dependency-presence check and, on failure, write the remediation
 * message and exit. Seams (`requireResolve`, `cwd`, `stderr`, `exit`,
 * `manifest`) make it fully testable without touching the real process.
 *
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

  // A manifest we cannot read is a packaging defect the drift test owns —
  // never let the guard kill an otherwise-healthy process over it.
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
 * Remediation text for a failed check.
 *
 * Absence is reported first: a package that is not installed cannot have a
 * version, and installing it is the prerequisite for any version complaint
 * being actionable.
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
 * Read a resolved package's version through the framework's own resolution,
 * so the version checked is the one the framework's imports will load.
 *
 * @param {string} name
 * @returns {string | null}
 */
function defaultReadVersion(name) {
  return resolveDependencyVersion(name, frameworkRequire);
}

/**
 * Load the manifest, swallowing a read/parse failure to `null` so the guard
 * stays inert on a packaging defect (see `ensureRuntimeDepsInstalled`).
 *
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
