/**
 * The `update-crap-baseline` CLI's testable logic: flags, options and its
 * scorer. The scorer stays bespoke (not the refresh-service default) because
 * its fail-closed resolution floor must not change behaviour for the other
 * callers of that default.
 */

import path from 'node:path';
import { getBaselines, getQuality, resolveConfig } from '../config-resolver.js';
import { isCoverageFresh } from '../coverage-capture.js';
import { loadCoverage as loadCoverageDefault } from '../coverage-utils.js';
import { checkResolutionFloor, scanAndScore } from '../crap-utils.js';
import { Logger } from '../Logger.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';
import {
  checkSeatResolution,
  runSeatMissing,
  SeatRefusal,
} from './seat-missing.js';

const DEFAULT_COVERAGE_PATH = 'coverage/coverage-final.json';

const DEFAULT_MIN_RESOLUTION_RATE = 0.75;

/**
 * Scope flags are not reconciled here; {@link resolveCrapUpdaterOptions} owns
 * that refusal.
 *
 * @param {string[]} [argv]
 * @returns {{baselinePath: string|undefined, coveragePath: string|undefined,
 *   fullScope: boolean, diffScopeRef: string|null, seatMissing: boolean}}
 */
export function parseCrapUpdaterArgs(argv = []) {
  const out = {
    baselinePath: undefined,
    coveragePath: undefined,
    fullScope: false,
    diffScopeRef: parseDiffScopeFlag(argv),
    seatMissing: argv.includes('--seat-missing'),
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
 * Flag → config → default. Throws on `--full-scope` with `--diff-scope`:
 * silently preferring one would write a baseline nobody asked for
 * (`runSeatMissing` refuses the `--seat-missing` pairing).
 *
 * @param {{baselinePath?: string, coveragePath?: string, fullScope?: boolean,
 *   diffScopeRef?: string|null, seatMissing?: boolean}} args
 * @param {{crap?: object, baselines?: object}} sources
 * @param {string} [cwd]
 * @returns {{targetDirs: string[], ignoreGlobs: string[],
 *   requireCoverage: boolean, minMethodResolutionRate: number,
 *   coveragePath: string, baselinePath: string, absBaselinePath: string,
 *   fullScope: boolean, diffScopeRef: string|null, seatMissing: boolean}}
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
    seatMissing: Boolean(args.seatMissing),
  };
}

/**
 * Non-zero drop counters only. `unscorableFiles` must be reported, or the run
 * reads as a clean scan of a smaller tree.
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
 * Fails closed on a missing coverage artifact under `requireCoverage` (warn,
 * no rows) and on a resolution rate below the floor (throws before anything is
 * written: a broken join is wrong, not sparse).
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

/** Stamp scopes a capture may have written; any one fresh stamp suffices. */
const CAPTURE_SCOPES = ['full', 'incremental', 'affected'];

/**
 * The `--seat-missing` scorer: refuses (throws {@link SeatRefusal}) unless
 * the coverage artifact is fresh for the current tree and every in-scope
 * method resolved a coverage entry — a wrong-coordinate row stays wrong even
 * when it is only inserted.
 *
 * @param {ReturnType<typeof resolveCrapUpdaterOptions>} options
 * @param {{loadCoverage: Function, scan?: Function, isFresh?: Function,
 *   cwd?: string, logger?: object}} deps
 * @returns {(files: string[]) => Promise<object[]>}
 */
export function buildCrapSeatScorer(
  options,
  {
    loadCoverage,
    scan = scanAndScore,
    isFresh = isCoverageFresh,
    cwd = process.cwd(),
    logger = Logger,
  } = {},
) {
  const fixCommand = `node .agents/scripts/coverage-capture.js --cwd ${cwd}`;
  return async (files) => {
    const fresh = CAPTURE_SCOPES.some(
      (requireScope) =>
        isFresh({
          coveragePath: options.coveragePath,
          targetDirs: options.targetDirs,
          cwd,
          requireScope,
        }).fresh,
    );
    const coverage = fresh
      ? loadCoverage(path.resolve(cwd, options.coveragePath))
      : null;
    if (!coverage) {
      throw new SeatRefusal(
        `[CRAP] --seat-missing refused: no coverage artifact at ${options.coveragePath} is fresh for the current tree ` +
          `(method resolution unmeasured; unresolved files: ${files.join(', ')}).\n` +
          `Fix: re-capture coverage for the current tree — ${fixCommand}`,
      );
    }
    const summary = await scan({
      targetDirs: options.targetDirs,
      coverage,
      requireCoverage: options.requireCoverage,
      cwd,
      ignoreGlobs: options.ignoreGlobs,
      scopeFiles: files,
    });
    reportScanSummary(summary, logger);
    const refusal = checkSeatResolution(summary.resolution, fixCommand);
    if (refusal) throw new SeatRefusal(refusal);
    return (summary.rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };
}

/**
 * `update-crap-baseline.js --seat-missing`: seat the diff's new methods
 * through {@link buildCrapSeatScorer}. Resolves to the exit code.
 *
 * @param {string[]} argv
 * @param {{config?: object}} [deps]
 * @returns {Promise<number>}
 */
export function seatCrapBaseline(argv, { config = resolveConfig() } = {}) {
  const options = resolveCrapUpdaterOptions(parseCrapUpdaterArgs(argv), {
    crap: getQuality(config).crap,
    baselines: getBaselines(config),
  });
  return runSeatMissing({
    kind: 'crap',
    label: 'CRAP',
    writePath: options.absBaselinePath,
    diffScopeRef: options.diffScopeRef,
    fullScope: options.fullScope,
    baseBranch: config.project.baseBranch,
    score: buildCrapSeatScorer(options, { loadCoverage: loadCoverageDefault }),
  });
}
