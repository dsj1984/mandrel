/**
 * lib/baselines/coverage-updater-cli.js — the `update-coverage-baseline` CLI's
 * scope-flag reconciliation and its bespoke scorer.
 *
 * Story #5316: both lived inside `update-coverage-baseline.js#main`, which no
 * test imports, so `main` scored CRAP 30 and the inlined scorer another 30 —
 * two of the ten methods Story #5311's honest re-anchor made visible, both at
 * 0% coverage.
 *
 * **Why this is NOT the `refresh-service.js` default scorer.** Story #4293's
 * idiom — drop the bespoke scorer, let `refreshBaseline` resolve the canonical
 * default — was the obvious move here, and `buildDefaultCoverageScorer` is
 * behaviour-equivalent line for line. It was rejected for one reason: the
 * default is silent where this one speaks. A missing or unreadable coverage
 * artifact makes any scorer return `[]`, and `refresh-service.js` has no
 * empty-rows guard, so a full-scope refresh then writes an emptied baseline at
 * exit 0. This scorer's `[Coverage] ❌` line is currently the only signal an
 * operator gets that it happened. Converging would have traded a CRAP row for
 * a quieter failure. (The fail-open itself is real and wants its own Story —
 * it changes `refreshBaseline` semantics for every caller.)
 */

import { Logger } from '../Logger.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';

/**
 * Reconcile the two scope flags.
 *
 * Throws when both are present: they describe incompatible scopes, and
 * silently preferring one would write a baseline the operator did not ask for.
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
 * Build the scorer `refreshBaseline` invokes.
 *
 * Reads `coverage-final.json`, narrows to the c8 include/exclude scope so the
 * baseline records exactly the files coverage is measured over, and — in diff
 * mode — narrows again to the service-resolved in-scope list so untouched rows
 * are preserved rather than re-scored.
 *
 * The three collaborators are named seams (`rules/test-seams.md`) so a test
 * drives the whole scorer with no coverage artifact and no `.c8rc.cjs` on
 * disk.
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
      // The only operator-facing signal that the refresh is about to record
      // nothing — see this module's header.
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

    // In diff mode, further narrow to the service-resolved in-scope file list.
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
