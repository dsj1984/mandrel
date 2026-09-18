/**
 * Static BDD runner detection: does the project ship a runner with a
 * pending/skip tag? If so the planner can order features-first (scenarios
 * land `@skip` ahead of the implementation); if not, dependencies-first,
 * since an unimplemented scenario would be a permanent red. Reads the root
 * `package.json` plus every workspace package (runners usually live in one),
 * never boots the runner.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import picomatch from 'picomatch';

import { Logger } from './Logger.js';

/** npm package name → pending tag. Preferred-first: the first match wins. */
export const BDD_RUNNER_TAG_TABLE = Object.freeze({
  'playwright-bdd': '@skip',
  '@cucumber/cucumber': '@skip',
  'cucumber-js': '@skip',
  cucumber: '@skip',
});

/**
 * Tags meaning "coverage pending, not satisfied", in both `@skip` and
 * `skip` forms (parsers may strip the `@`).
 */
export const PENDING_TAGS = Object.freeze(
  new Set(
    Object.values(BDD_RUNNER_TAG_TABLE).flatMap((tag) => [
      tag,
      tag.startsWith('@') ? tag.slice(1) : `@${tag}`,
    ]),
  ),
);

const FALLBACK = Object.freeze({
  runner: null,
  pendingTag: null,
  supported: false,
  fallback: true,
  reason: 'no-bdd-runner-detected',
});

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {(p: string) => Promise<string>} [opts.readPkg] Test seam.
 * @param {(ctx: { cwd: string, rootPkg: object, readPkg: Function }) => Promise<string[]>} [opts.listWorkspacePkgPaths]
 *   Test seam.
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
 * Workspace `package.json` paths from `pnpm-workspace.yaml`, else the root
 * `workspaces` field. Non-fatal: `[]` on any failure.
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

/** Handles literal dirs, `*` and `**` globs, and `!` exclusions. */
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

/** Canonical `.feature` directories; there is no config key for others. */
const CANONICAL_FEATURE_ROOTS = Object.freeze([
  'tests/features',
  'features',
  'test/features',
]);

/**
 * Existing canonical feature roots; `[]` when the project has not adopted BDD.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {string[]}
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
      logger.debug(
        `[bdd-runner-detect] feature-root probe failed for ${abs}: ${err?.message ?? err}`,
      );
    }
  }
  return roots;
}
