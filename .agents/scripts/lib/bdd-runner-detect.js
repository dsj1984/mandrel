/**
 * BDD runner detection + pending-tag verification (Epic #2001 Story #2094
 * Task #2103).
 *
 * Used by `epic-plan-spec.js#buildAuthoringContext` to decide whether the
 * acceptance-spec body should plan **features-first** Story ordering (a real
 * pending-tag is available, so the features-first Story can ship `.feature`
 * files marked `@pending` / `@skip` ahead of the implementation Stories) or
 * fall back to **dependencies-first** ordering (no pending tag → cannot
 * suspend an unimplemented scenario without a permanent red, so Stories run
 * in dependency order and the AC reconciler defers).
 *
 * The verification is **static**: we inspect `package.json` for a known BDD
 * runner dependency, and consult a small lookup table of which runners
 * support which pending/skip tag. We do not boot the runner. This keeps
 * `/epic-plan` Phase 7 hermetic and offline.
 *
 * Output shape (returned to the planner-context envelope):
 *
 *   { runner: 'cucumber-js',         pendingTag: '@skip',     supported: true,  fallback: false }
 *   { runner: 'playwright-bdd',      pendingTag: '@skip',     supported: true,  fallback: false }
 *   { runner: '@cucumber/cucumber',  pendingTag: '@skip',     supported: true,  fallback: false }
 *   { runner: null,                  pendingTag: null,        supported: false, fallback: true,
 *     reason: 'no-bdd-runner-detected' }
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Known BDD runner package names → pending-tag string the runner honours.
 *
 * Keys MUST match the literal npm package name as it appears in
 * `dependencies` or `devDependencies`. Order is preferred-first: if multiple
 * runners are present (rare), the first match wins.
 */
export const BDD_RUNNER_TAG_TABLE = Object.freeze({
  'playwright-bdd': '@skip',
  '@cucumber/cucumber': '@skip',
  'cucumber-js': '@skip',
  cucumber: '@skip',
});

/**
 * Shared set of tag tokens that mean "this scenario does not yet satisfy
 * its AC — treat coverage as pending, not satisfied." Sourced from every
 * `pendingTag` value in `BDD_RUNNER_TAG_TABLE` plus the historical
 * `@pending` literal for backward compatibility with feature files
 * authored before runner-aware detection.
 *
 * Both the prefixed (`@skip`) and the unprefixed (`skip`) form of each
 * tag are included so consumers can look up either the raw tag string
 * (as it appears in a `.feature` file) or the normalized token form
 * produced by tag-block parsers that strip the leading `@`.
 *
 * Consumers:
 *   - `acceptance-spec-reconciler.classifyCoverage` — membership check
 *     against parsed scenario tag sets.
 *   - Contract tests that walk `BDD_RUNNER_TAG_TABLE` and assert each
 *     `pendingTag` is registered here, guarding against drift when a
 *     new runner is added.
 */
export const PENDING_TAGS = Object.freeze(
  new Set([
    ...Object.values(BDD_RUNNER_TAG_TABLE).flatMap((tag) => [
      tag,
      tag.startsWith('@') ? tag.slice(1) : `@${tag}`,
    ]),
    '@pending',
    'pending',
  ]),
);

/**
 * Result returned when no supported BDD runner is detected. The acceptance
 * spec body will print "Fallback: dependencies-first ordering" and Phase 8
 * decomposer ordering reverts to topological dependency order.
 */
const FALLBACK = Object.freeze({
  runner: null,
  pendingTag: null,
  supported: false,
  fallback: true,
  reason: 'no-bdd-runner-detected',
});

/**
 * Verify which BDD runner (if any) the project ships and whether it
 * supports a pending/skip tag. Pure — only reads `package.json` from disk.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root holding `package.json`.
 * @param {(p: string) => Promise<string>} [opts.readPkg] - Override for
 *   tests; receives the resolved absolute path to `package.json`.
 * @returns {Promise<{ runner: string|null, pendingTag: string|null, supported: boolean, fallback: boolean, reason?: string }>}
 */
export async function verifyBddRunnerPendingTag(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const readPkg = opts.readPkg ?? ((p) => readFile(p, 'utf8'));
  const pkgPath = path.join(cwd, 'package.json');

  let raw;
  try {
    raw = await readPkg(pkgPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...FALLBACK, reason: 'package-json-missing' };
    }
    throw err;
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return { ...FALLBACK, reason: `package-json-parse-error:${err.message}` };
  }

  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  for (const [runner, pendingTag] of Object.entries(BDD_RUNNER_TAG_TABLE)) {
    if (Object.hasOwn(deps, runner)) {
      return {
        runner,
        pendingTag,
        supported: true,
        fallback: false,
      };
    }
  }

  return { ...FALLBACK };
}

/**
 * Canonical directories a project might use to house `.feature` files.
 * Probed in order; the first existing directory wins. The list is
 * deliberately short — projects that house features elsewhere will need
 * to land an explicit config surface for it, which Story #2637 leaves
 * out of scope.
 */
const CANONICAL_FEATURE_ROOTS = Object.freeze([
  'tests/features',
  'features',
  'test/features',
]);

/**
 * Resolve the project's BDD feature roots — absolute paths to every
 * canonical directory that exists under `cwd`. Returns an empty array
 * when no feature directory is present (the project has not adopted
 * BDD), so downstream scanners can degrade silently to "no scenarios".
 *
 * Story #2637 — the Phase 7 BDD-scenario scanner consumes this so the
 * planner can cross-reference acceptance criteria against existing
 * scenarios without introducing a new config key.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {string[]} Absolute paths to existing feature roots.
 */
export function resolveFeatureRoots(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const roots = [];
  for (const candidate of CANONICAL_FEATURE_ROOTS) {
    const abs = path.join(cwd, candidate);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        roots.push(abs);
      }
    } catch (_err) {
      // Unreadable path → treat as absent. Non-blocking by design.
    }
  }
  return roots;
}
