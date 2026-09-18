/**
 * The `update-coverage-baseline` CLI's testable logic. The scorer stays
 * bespoke (not the refresh-service default) because it logs when the coverage
 * artifact is missing: `refreshBaseline` has no empty-rows guard, so that line
 * is the only signal a full-scope refresh just wrote an empty baseline.
 */

import { Logger } from '../Logger.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';

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
    let raw;
    try {
      raw = readCoverage(effectiveCwd);
    } catch (err) {
      logger.error(`[Coverage] ❌ ${err.message}`);
      return [];
    }

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
