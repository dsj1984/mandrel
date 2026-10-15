// lib/cli/doctor-checks/runtime-deps.js — Doctor checks: runtime-deps, agents-materialized.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isResolvable } from '../../../.agents/scripts/lib/runtime-deps/dep-resolution.js';
import { describeParserMajorError } from '../../../.agents/scripts/lib/runtime-deps/parser-major.js';

// check: runtime-deps

/**
 * Presence is not enough: a declared range cannot pin which `@babel/parser`
 * major the consumer's node_modules supplies, and the wrong one fails
 * scoring mid-scan with an opaque error — so report it here.
 *
 * @param {() => string|null} parserMajorError
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function allPresentVerdict(parserMajorError) {
  const parserProblem = parserMajorError();
  if (parserProblem === null) {
    return { ok: true, detail: 'all dependencies found' };
  }
  return {
    ok: false,
    detail: 'dependency version unsupported',
    remedy: parserProblem,
  };
}

/**
 * Are the runtime deps resolvable from the consumer root? Anchored at
 * `process.cwd()`, not the package root: under pnpm isolated mode the
 * consumer's node_modules are invisible from `node_modules/mandrel/`.
 *
 * @param {{ projectRoot?: string, resolve?: (dep: string) => string, manifestRequired?: string[] }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runRuntimeDeps({
  projectRoot,
  resolve: resolveSeam,
  manifestRequired,
  parserMajorError = describeParserMajorError,
} = {}) {
  const root = projectRoot ?? process.cwd();

  let required = manifestRequired;
  if (!required) {
    try {
      const manifestPath = path.join(root, '.agents', 'runtime-deps.json');
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      required = Object.keys(parsed.dependencies ?? {});
    } catch {
      required = [];
    }
  }

  if (required.length === 0) {
    return { ok: true, detail: 'all dependencies found' };
  }

  const missing = [];

  // `isResolvable` also probes `<name>/package.json`: a dep with no `main`
  // and no `exports` cannot be resolved by bare name yet is installed.
  const resolve =
    resolveSeam ?? createRequire(path.join(root, 'package.json')).resolve;
  for (const dep of required) {
    if (!isResolvable(dep, resolve)) missing.push(dep);
  }

  if (missing.length === 0) return allPresentVerdict(parserMajorError);
  return {
    ok: false,
    detail: `missing: ${missing.join(', ')}`,
    remedy:
      'The framework runtime deps are not resolvable from the consumer root, ' +
      'where the materialized .agents/scripts/*.js run. npm and yarn hoist ' +
      "them automatically — run the installer if you haven't. pnpm's default " +
      'isolated layout does NOT hoist transitive deps to the top level: add ' +
      '`shamefully-hoist=true` (or a scoped `public-hoist-pattern[]` for ' +
      'each dep) to your `.npmrc` and reinstall. ' +
      `Missing: ${missing.join(', ')}`,
  };
}

// check: agents-materialized

/**
 * Is `./.agents/instructions.md` present? Absent with the package installed
 * means postinstall was skipped (`--ignore-scripts`, sandboxed CI). Both
 * lookups anchor at the consumer's cwd.
 *
 * @param {{
 *   cwd?: () => string,
 *   existsSync?: (p: string) => boolean,
 *   resolvePackage?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runAgentsMaterialized({
  cwd,
  existsSync,
  resolvePackage,
} = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const exists = existsSync ?? ((p) => fs.existsSync(p));
  const root = getCwd();
  const instructionsPath = path.join(root, '.agents', 'instructions.md');

  if (exists(instructionsPath)) {
    return { ok: true, detail: '.agents/ materialized' };
  }

  const resolvePkg =
    resolvePackage ??
    ((fromDir) => {
      const requireFrom = createRequire(path.join(fromDir, 'noop.js'));
      return requireFrom.resolve('mandrel/package.json');
    });

  let packageInstalled = false;
  try {
    resolvePkg(root);
    packageInstalled = true;
  } catch {
    packageInstalled = false;
  }

  if (packageInstalled) {
    return {
      ok: false,
      detail: 'mandrel installed but ./.agents/ not materialized',
      remedy:
        'Run `mandrel sync` to materialize the .agents/ payload (postinstall was skipped).',
    };
  }

  return {
    ok: false,
    detail: 'mandrel not installed and ./.agents/ absent',
    remedy:
      'Install the framework (`npm install mandrel`), then run `mandrel sync`.',
  };
}
