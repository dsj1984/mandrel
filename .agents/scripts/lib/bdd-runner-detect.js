/**
 * BDD runner detection + pending-tag verification (Epic #2001 Story #2094
 * Task #2103; workspace-aware extension from Story #2956).
 *
 * Used by `buildAuthoringContext` (the `plan-context.js` envelope) to decide whether the
 * acceptance-table section should plan **features-first** Story ordering (a real
 * pending-tag is available, so the features-first Story can ship `.feature`
 * files marked `@pending` / `@skip` ahead of the implementation Stories) or
 * fall back to **dependencies-first** ordering (no pending tag → cannot
 * suspend an unimplemented scenario without a permanent red, so Stories run
 * in dependency order and the AC reconciler defers).
 *
 * The verification is **static**: we inspect `package.json` for a known BDD
 * runner dependency, and consult a small lookup table of which runners
 * support which pending/skip tag. We do not boot the runner. This keeps
 * `/plan` Phase 7 hermetic and offline.
 *
 * **Workspace awareness (Story #2956).** In a pnpm / npm / yarn monorepo the
 * BDD runner is rarely a root devDependency — it lives in the workspace
 * package that owns the e2e suite (e.g. `apps/web/package.json`). The
 * detector reads the root `package.json` first and then unions in
 * dependencies from every declared workspace package, so an `apps/*` shaped
 * monorepo no longer falls back to "no runner detected" when the runner
 * sits one level down. Workspace declarations are read from
 * `pnpm-workspace.yaml` (`packages:` field) or the root `package.json`
 * `workspaces` field (array or `{ packages: [] }` object form).
 * Preferred-first ordering is preserved by iterating
 * `BDD_RUNNER_TAG_TABLE` against the union of all collected deps — the
 * first runner present in *any* package wins.
 *
 * Output shape (returned to the planner-context envelope):
 *
 *   { runner: 'cucumber-js',         pendingTag: '@skip',     supported: true,  fallback: false }
 *   { runner: 'playwright-bdd',      pendingTag: '@skip',     supported: true,  fallback: false }
 *   { runner: '@cucumber/cucumber',  pendingTag: '@skip',     supported: true,  fallback: false }
 *   { runner: null,                  pendingTag: null,        supported: false, fallback: true,
 *     reason: 'no-bdd-runner-detected' }
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import picomatch from 'picomatch';

import { Logger } from './Logger.js';

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
 * supports a pending/skip tag. Reads the root `package.json` and (when
 * declared) every workspace `package.json` so monorepos that house the
 * runner in `apps/<name>` or `packages/<name>` resolve correctly.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Project root holding `package.json`.
 * @param {(p: string) => Promise<string>} [opts.readPkg] - Override for
 *   tests; receives the resolved absolute path to a `package.json`.
 * @param {(ctx: { cwd: string, rootPkg: object, readPkg: Function }) => Promise<string[]>} [opts.listWorkspacePkgPaths]
 *   Override for tests; returns absolute paths to workspace `package.json`
 *   files. Defaults to scanning `pnpm-workspace.yaml` then the root
 *   `package.json` `workspaces` field and expanding their glob patterns.
 * @returns {Promise<{ runner: string|null, pendingTag: string|null, supported: boolean, fallback: boolean, reason?: string }>}
 */
export async function verifyBddRunnerPendingTag(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const readPkg = opts.readPkg ?? ((p) => readFile(p, 'utf8'));
  const listWorkspacePkgPaths =
    opts.listWorkspacePkgPaths ?? defaultListWorkspacePkgPaths;
  const logger = opts.logger ?? Logger;
  const rootPkgPath = path.join(cwd, 'package.json');

  let raw;
  try {
    raw = await readPkg(rootPkgPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...FALLBACK, reason: 'package-json-missing' };
    }
    throw err;
  }

  let rootPkg;
  try {
    rootPkg = JSON.parse(raw);
  } catch (err) {
    return { ...FALLBACK, reason: `package-json-parse-error:${err.message}` };
  }

  const allDeps = {
    ...(rootPkg.dependencies ?? {}),
    ...(rootPkg.devDependencies ?? {}),
  };

  let workspacePkgPaths = [];
  try {
    workspacePkgPaths = await listWorkspacePkgPaths({
      cwd,
      rootPkg,
      readPkg,
      logger,
    });
  } catch (err) {
    // Workspace discovery failure is non-fatal: degrade to root-only scan.
    logger.debug(
      `[bdd-runner-detect] workspace discovery failed for ${cwd}: ${err?.message ?? err}`,
    );
    workspacePkgPaths = [];
  }

  for (const wsPkgPath of workspacePkgPaths) {
    let wsRaw;
    try {
      wsRaw = await readPkg(wsPkgPath);
    } catch (err) {
      logger.debug(
        `[bdd-runner-detect] readPkg failed for workspace ${wsPkgPath}: ${err?.message ?? err}`,
      );
      continue;
    }
    let wsPkg;
    try {
      wsPkg = JSON.parse(wsRaw);
    } catch (err) {
      logger.debug(
        `[bdd-runner-detect] JSON parse failed for workspace ${wsPkgPath}: ${err?.message ?? err}`,
      );
      continue;
    }
    Object.assign(
      allDeps,
      wsPkg.dependencies ?? {},
      wsPkg.devDependencies ?? {},
    );
  }

  for (const [runner, pendingTag] of Object.entries(BDD_RUNNER_TAG_TABLE)) {
    if (Object.hasOwn(allDeps, runner)) {
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
 * Default workspace discovery: read `pnpm-workspace.yaml` (`packages:`
 * field) then the root `package.json` `workspaces` field, expand the
 * glob patterns against `cwd`, and return the resulting workspace
 * `package.json` absolute paths.
 *
 * Returns `[]` (silent) on any of:
 *   - no `pnpm-workspace.yaml` and no `workspaces` field
 *   - YAML parse failure
 *   - patterns matching no on-disk directories
 *
 * Failures here are non-fatal so a malformed workspace file can never
 * block planner-context emission.
 *
 * @returns {Promise<string[]>}
 */
async function defaultListWorkspacePkgPaths({ cwd, rootPkg, logger }) {
  const log = logger ?? Logger;
  const patterns = readWorkspacePatterns(cwd, rootPkg, log);
  if (patterns.length === 0) return [];
  return expandWorkspacePatterns(cwd, patterns, log);
}

function readWorkspacePatterns(cwd, rootPkg, logger) {
  const yamlPath = path.join(cwd, 'pnpm-workspace.yaml');
  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf8');
      const parsed = yaml.load(raw);
      if (parsed && Array.isArray(parsed.packages)) {
        return parsed.packages.filter((p) => typeof p === 'string');
      }
    } catch (err) {
      // unparseable yaml → fall through to package.json workspaces
      logger.debug(
        `[bdd-runner-detect] pnpm-workspace.yaml parse failed for ${yamlPath}: ${err?.message ?? err}`,
      );
    }
  }

  if (rootPkg) {
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) {
      return ws.filter((p) => typeof p === 'string');
    }
    if (ws && Array.isArray(ws.packages)) {
      return ws.packages.filter((p) => typeof p === 'string');
    }
  }

  return [];
}

/**
 * Expand a list of workspace glob patterns into absolute paths to each
 * matching `package.json`. Handles:
 *   - literal directory entries (no glob chars): `apps/web`
 *   - single-segment globs: `apps/*`, `packages/*`
 *   - recursive globs: `packages/**`
 *   - exclusion patterns prefixed with `!` (pnpm/npm convention)
 */
function expandWorkspacePatterns(cwd, patterns, logger) {
  const includes = patterns.filter((p) => !p.startsWith('!'));
  const excludes = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => p.slice(1));
  const excludeMatchers = excludes.map((e) => picomatch(e));

  const results = new Set();

  for (const pattern of includes) {
    if (!hasGlobChar(pattern)) {
      const dir = path.join(cwd, pattern);
      const pkgPath = path.join(dir, 'package.json');
      const rel = toPosix(path.relative(cwd, dir));
      if (existsSync(pkgPath) && !excludeMatchers.some((m) => m(rel))) {
        results.add(pkgPath);
      }
      continue;
    }

    const segments = pattern.split('/');
    const literalSegments = [];
    let i = 0;
    while (i < segments.length && !hasGlobChar(segments[i])) {
      literalSegments.push(segments[i]);
      i++;
    }
    const baseDir = path.join(cwd, ...literalSegments);
    if (!existsSyncDir(baseDir, logger)) continue;
    const recursive = segments.slice(i).includes('**');
    const includeMatcher = picomatch(pattern);
    walkPackages({
      dir: baseDir,
      relBase: literalSegments.join('/'),
      includeMatcher,
      excludeMatchers,
      recursive,
      results,
      logger,
    });
  }

  return [...results];
}

function walkPackages({
  dir,
  relBase,
  includeMatcher,
  excludeMatchers,
  recursive,
  results,
  logger,
}) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger?.debug(
      `[bdd-runner-detect] readdir failed for ${dir}: ${err?.message ?? err}`,
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (includeMatcher(rel) && !excludeMatchers.some((m) => m(rel))) {
      const pkgPath = path.join(full, 'package.json');
      if (existsSync(pkgPath)) results.add(pkgPath);
    }
    if (recursive) {
      walkPackages({
        dir: full,
        relBase: rel,
        includeMatcher,
        excludeMatchers,
        recursive,
        results,
        logger,
      });
    }
  }
}

function hasGlobChar(s) {
  return /[*?[]/.test(s);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function existsSyncDir(p, logger) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch (err) {
    logger?.debug(
      `[bdd-runner-detect] stat failed for ${p}: ${err?.message ?? err}`,
    );
    return false;
  }
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
  const logger = opts.logger ?? Logger;
  const roots = [];
  for (const candidate of CANONICAL_FEATURE_ROOTS) {
    const abs = path.join(cwd, candidate);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        roots.push(abs);
      }
    } catch (err) {
      // Unreadable path → treat as absent. Non-blocking by design.
      logger.debug(
        `[bdd-runner-detect] feature-root probe failed for ${abs}: ${err?.message ?? err}`,
      );
    }
  }
  return roots;
}
