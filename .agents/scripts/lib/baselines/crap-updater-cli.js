/**
 * lib/baselines/crap-updater-cli.js — the `update-crap-baseline` CLI's own
 * logic: flag parsing, option defaulting, and the bespoke scorer it hands
 * `refreshBaseline`.
 *
 * Story #5316: all three lived inside `update-crap-baseline.js#main`, which no
 * test imports. `parseCliArgs` scored CRAP 56, the inlined scorer 72, and
 * `main` itself 90 — three of the ten methods Story #5311's honest re-anchor
 * made visible, every one at 0% coverage. They sit here for the same reason
 * `diff-scope-cli.js` does: a CLI shell is unreachable from a test, and the
 * import from the CLI is what keeps these off the `dead-exports:production`
 * ratchet.
 *
 * **Why this is NOT the `refresh-service.js` default scorer.** The service
 * already resolves a `buildDefaultCrapScorer`, and Story #4293 made
 * `update-maintainability-baseline.js` drop its bespoke scorer in favour of
 * exactly that. This one cannot follow: it carries `checkResolutionFloor`, a
 * fail-closed refusal that throws before anything is written when too few
 * methods resolved a coverage entry — the guard that stops a broken join being
 * persisted as a sparse baseline (Story #4775). Moving that into the shared
 * default would change behaviour for `refresh-commit.js` and close-validation,
 * which resolve the same default. So the scorer stays bespoke, and is tested
 * here instead.
 */

import path from 'node:path';
import { checkResolutionFloor, scanAndScore } from '../crap-utils.js';
import { Logger } from '../Logger.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';

/** Coverage artifact read when neither the flag nor config names one. */
const DEFAULT_COVERAGE_PATH = 'coverage/coverage-final.json';

/** Resolution-rate floor applied when config does not set one. */
const DEFAULT_MIN_RESOLUTION_RATE = 0.75;

/**
 * Parse the updater's argv.
 *
 * `--full-scope` and `--diff-scope <ref>` are read here but deliberately NOT
 * reconciled — {@link resolveCrapUpdaterOptions} owns the refusal, so a caller
 * cannot get a half-validated shape by calling only this.
 *
 * @param {string[]} [argv]
 * @returns {{baselinePath: string|undefined, coveragePath: string|undefined,
 *   fullScope: boolean, diffScopeRef: string|null}}
 */
export function parseCrapUpdaterArgs(argv = []) {
  const out = {
    baselinePath: undefined,
    coveragePath: undefined,
    fullScope: false,
    diffScopeRef: parseDiffScopeFlag(argv),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline' && argv[i + 1]) {
      out.baselinePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--coverage' && argv[i + 1]) {
      out.coveragePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--full-scope') {
      out.fullScope = true;
    }
  }
  return out;
}

/**
 * Fold parsed args over the project's quality config into the one shape the
 * CLI and the scorer both read.
 *
 * Every flag wins over config, and config over the built-in default — the
 * precedence that used to be a chain of `??` inside `main`, which is most of
 * why `main` was cyclomatic 9.
 *
 * Throws on `--full-scope` together with `--diff-scope`: the two describe
 * incompatible scopes and silently preferring one would write a baseline the
 * operator did not ask for.
 *
 * @param {{baselinePath?: string, coveragePath?: string, fullScope?: boolean,
 *   diffScopeRef?: string|null}} args From {@link parseCrapUpdaterArgs}.
 * @param {{crap?: object, baselines?: object}} sources Resolved config slices:
 *   `crap` is the quality block, `baselines` the baselines block.
 * @param {string} [cwd] Root the baseline path is resolved against.
 * @returns {{targetDirs: string[], ignoreGlobs: string[],
 *   requireCoverage: boolean, minMethodResolutionRate: number,
 *   coveragePath: string, baselinePath: string, absBaselinePath: string,
 *   fullScope: boolean, diffScopeRef: string|null}}
 */
export function resolveCrapUpdaterOptions(
  args = {},
  { crap = {}, baselines = {} } = {},
  cwd = process.cwd(),
) {
  if (args.fullScope && args.diffScopeRef != null) {
    throw new Error(
      '[CRAP] --full-scope is incompatible with --diff-scope; pick one',
    );
  }
  const baselinePath = args.baselinePath ?? baselines?.crap?.path;
  const coveragePath =
    args.coveragePath ?? crap.coveragePath ?? DEFAULT_COVERAGE_PATH;
  return {
    targetDirs: Array.isArray(crap.targetDirs) ? crap.targetDirs : [],
    ignoreGlobs: Array.isArray(crap.ignoreGlobs) ? crap.ignoreGlobs : [],
    requireCoverage: crap.requireCoverage !== false,
    minMethodResolutionRate:
      crap.minMethodResolutionRate ?? DEFAULT_MIN_RESOLUTION_RATE,
    coveragePath,
    baselinePath,
    absBaselinePath: path.isAbsolute(baselinePath)
      ? baselinePath
      : path.resolve(cwd, baselinePath),
    fullScope: Boolean(args.fullScope),
    diffScopeRef: args.diffScopeRef ?? null,
  };
}

/**
 * Report a scan's drop counters. Each earns a line only when it moved, so a
 * clean scan stays quiet.
 *
 * `unscorableFiles` (Story #5311) is the one that must never be silent: a file
 * the scan could not read, transpile or parse contributes no rows, so without
 * a line of its own the run reads as a clean scan of a tree with fewer methods
 * than it has.
 *
 * @param {{skippedFilesNoCoverage?: number, skippedMethodsNoCoverage?: number,
 *   unscorableFiles?: number, resolution?: object}} summary
 * @param {{info: Function}} [logger]
 */
function reportScanSummary(summary, logger = Logger) {
  const counters = [
    [
      summary.skippedFilesNoCoverage,
      'file(s) skipped without coverage entries.',
    ],
    [
      summary.skippedMethodsNoCoverage,
      'method(s) skipped — per-method coverage unresolved.',
    ],
    [
      summary.unscorableFiles,
      'file(s) unscorable (read/transpile/parse failure) — no rows contributed.',
    ],
  ];
  for (const [count, what] of counters) {
    if (count > 0) logger.info(`[CRAP] ${count} ${what}`);
  }
  const r = summary.resolution;
  if (r) {
    logger.info(
      `[CRAP] Method resolution: ${r.resolvedMethods}/${r.joinableMethods} ` +
        `(${(r.rate * 100).toFixed(1)}%) in files with coverage.`,
    );
  }
}

/**
 * Build the scorer `refreshBaseline` invokes.
 *
 * Fails closed twice, and both refusals are the point of keeping this bespoke:
 *
 *   - **No coverage artifact under `requireCoverage`** — every file would be
 *     skipped, so the scan is abandoned with an operator-facing warning rather
 *     than returning a confidently empty row set.
 *   - **Resolution rate below the floor** — `checkResolutionFloor` throws
 *     BEFORE the service writes anything. A baseline built from a broken join
 *     is not sparse, it is wrong.
 *
 * `loadCoverage` and the logger are named seams so a test drives the whole
 * scorer without a coverage artifact on disk (`rules/test-seams.md`).
 *
 * @param {ReturnType<typeof resolveCrapUpdaterOptions>} options
 * @param {{loadCoverage: Function, scan?: Function, logger?: object}} deps
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
export function buildCrapUpdaterScorer(
  options,
  { loadCoverage, scan = scanAndScore, logger = Logger } = {},
) {
  return async (files, opts) => {
    const effectiveCwd = opts?.cwd ?? process.cwd();
    const coverageAbs = path.isAbsolute(options.coveragePath)
      ? options.coveragePath
      : path.resolve(effectiveCwd, options.coveragePath);
    const coverage = loadCoverage(coverageAbs);
    if (!coverage && options.requireCoverage) {
      logger.warn(
        `[CRAP] ⚠ No coverage artifact at ${options.coveragePath}. All files will be skipped under requireCoverage=true.`,
      );
      logger.warn(
        "[CRAP] ⚠ Run 'npm run test:coverage' before 'npm run crap:update'.",
      );
      return [];
    }

    const summary = await scan({
      targetDirs: options.targetDirs,
      coverage,
      requireCoverage: options.requireCoverage,
      cwd: effectiveCwd,
      ignoreGlobs: options.ignoreGlobs,
      scopeFiles: opts?.fullScope ? null : (files ?? null),
    });

    logger.info(`[CRAP] Scanned ${summary.scannedFiles} file(s).`);
    reportScanSummary(summary, logger);

    // Fail closed BEFORE the service persists anything — a thin baseline is
    // never written and then apologised for.
    const refusal = checkResolutionFloor(
      summary.resolution,
      options.minMethodResolutionRate,
    );
    if (refusal) throw new Error(refusal);

    return (summary.rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };
}
