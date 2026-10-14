/**
 * The `update-coverage-baseline` CLI's testable logic. The scorer stays
 * bespoke (not the refresh-service default) because it logs when the coverage
 * artifact is missing on a scoped refresh; a full-scope refresh rethrows, since
 * `refreshBaseline` has no empty-rows guard and would write an empty baseline.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getBaselineEpsilon } from '../config/quality.js';
import {
  buildScopePredicate,
  readCoverageFinal,
  scoreCoverageFinal,
} from '../coverage-baseline.js';
import { Logger } from '../Logger.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';

/** CommonJS `require`, for the `.c8rc.cjs` scope config. */
const require = createRequire(import.meta.url);

/**
 * The c8 include/exclude scope from `<cwd>/.c8rc.cjs` — the one
 * environment-bound step, which the scorer takes as a seam so a test never
 * touches a real config. A consumer measuring with another runner has no
 * `.c8rc.cjs`: that is an unscoped artifact, mirroring the refresh-service
 * default scorer.
 *
 * @param {string} cwd
 * @returns {{ include?: string[], exclude?: string[] }}
 */
export function loadC8ScopeConfig(cwd) {
  const c8rcPath = path.resolve(cwd, '.c8rc.cjs');
  if (!fs.existsSync(c8rcPath)) return {};
  return require(c8rcPath);
}

/**
 * Throws when both scope flags are present.
 *
 * @param {string[]} [argv]
 * @returns {{fullScope: boolean, diffScopeRef: string|null}}
 */
export function resolveCoverageUpdaterScope(argv = []) {
  const diffScopeRef = parseDiffScopeFlag(argv);
  const fullScope = argv.includes('--full-scope');
  if (fullScope && diffScopeRef !== null) {
    throw new Error(
      '[Coverage] --full-scope is incompatible with --diff-scope; pick one',
    );
  }
  return { fullScope, diffScopeRef };
}

/**
 * A full-scope refresh rethrows a read failure — over zero rows it would
 * write an empty baseline; a scoped one logs it and yields `null`.
 *
 * @returns {object|null}
 */
function readOrReport(readCoverage, cwd, opts, logger) {
  try {
    return readCoverage(cwd);
  } catch (err) {
    if (opts?.fullScope) throw err;
    logger.error(`[Coverage] ❌ ${err.message}`);
    return null;
  }
}

/**
 * Narrows to the c8 include/exclude scope, and in diff mode to the in-scope
 * files so untouched rows are preserved rather than re-scored.
 *
 * @param {string} cwd
 * @param {{readCoverage: Function, loadScope: Function, buildScope: Function,
 *   score: Function, logger?: object}} deps
 * @returns {(files: string[], opts: object) => object[]}
 */
function buildCoverageUpdaterScorer(
  cwd,
  { readCoverage, loadScope, buildScope, score, logger = Logger } = {},
) {
  return (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd;
    const raw = readOrReport(readCoverage, effectiveCwd, opts, logger);
    if (raw === null) return [];
    const c8Config = loadScope(effectiveCwd);
    const scores = score({
      raw,
      cwd: effectiveCwd,
      scope: buildScope({
        include: c8Config.include ?? [],
        exclude: c8Config.exclude ?? [],
      }),
    });
    return projectScoredRows(scores, files, opts, logger);
  };
}

/**
 * Baseline rows from per-file scores; in diff mode only the in-scope files,
 * so untouched rows are preserved rather than re-scored.
 *
 * @param {Record<string, object>} scores
 * @param {string[]} files
 * @param {{ fullScope?: boolean } | undefined} opts
 * @param {{ info: Function }} logger
 * @returns {object[]}
 */
function projectScoredRows(scores, files, opts, logger) {
  const inScope =
    !opts?.fullScope && Array.isArray(files) && files.length > 0
      ? new Set(files)
      : null;
  const rows = Object.entries(scores)
    .filter(([relPath]) => inScope === null || inScope.has(relPath))
    .map(([relPath, s]) => ({
      path: relPath,
      lines: s?.lines ?? 0,
      branches: s?.branches ?? 0,
      functions: s?.functions ?? 0,
    }));
  logger.info(
    `[Coverage] Scored ${Object.keys(scores).length} file(s)${inScope ? ` (${rows.length} in scope)` : ''}.`,
  );
  return rows;
}

/**
 * The configured artifact the refresh reads and the baseline it writes —
 * `coveragePath` / `baselinePath` from the resolved coverage gate, never a
 * hardcoded default.
 *
 * @param {{ coveragePath: string, baselinePath: string }} coverageGate
 * @param {string} cwd
 * @returns {{ coveragePath: string, baselinePath: string,
 *   absBaselinePath: string, readCoverage: (dir: string) => object }}
 */
export function coverageUpdaterTargets({ coveragePath, baselinePath }, cwd) {
  return {
    coveragePath,
    baselinePath,
    absBaselinePath: path.resolve(cwd, baselinePath),
    readCoverage: (dir) => readCoverageFinal(dir, { coveragePath }),
  };
}

/**
 * `refreshBaseline` options for the coverage updater. `deps` substitutes the
 * scorer's scope and scoring seams so a test never touches a real artifact.
 *
 * @param {string} cwd
 * @param {{ absBaselinePath: string, readCoverage: Function }} targets
 * @param {{ loadScope?: Function, buildScope?: Function, score?: Function,
 *   logger?: object }} [deps]
 * @returns {object}
 */
export function buildCoverageRefreshOpts(
  cwd,
  { absBaselinePath, readCoverage },
  {
    loadScope = loadC8ScopeConfig,
    buildScope = buildScopePredicate,
    score = scoreCoverageFinal,
    logger,
  } = {},
) {
  return {
    kind: 'coverage',
    writePath: absBaselinePath,
    epsilon: getBaselineEpsilon('coverage'),
    scorer: buildCoverageUpdaterScorer(cwd, {
      readCoverage,
      loadScope,
      buildScope,
      score,
      logger,
    }),
  };
}
