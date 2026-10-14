/**
 * The `update-coverage-baseline` CLI's testable logic. The scorer stays
 * bespoke (not the refresh-service default) because it logs when the coverage
 * artifact is missing on a scoped refresh; a full-scope refresh rethrows, since
 * `refreshBaseline` has no empty-rows guard and would write an empty baseline.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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
export function buildCoverageUpdaterScorer(
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

    const fileCount = Object.keys(scores).length;
    logger.info(
      `[Coverage] Scored ${fileCount} file(s)${inScope ? ` (${rows.length} in scope)` : ''}.`,
    );
    return rows;
  };
}
