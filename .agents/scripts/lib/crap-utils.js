import fs from 'node:fs';
import path from 'node:path';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import { findCoverageEntry } from './coverage-utils.js';
import { POOL_SERIAL_THRESHOLD, runOnPool } from './cpu-pool.js';
import {
  finalizeMethodRowsWithBaseline,
  resolveIncrementalContext,
  resolveQueueIncrementalFields,
  shouldSkipFileForNoCoverage,
} from './crap-baseline-join.js';
import { COORDINATE_ORIGINAL, methodRowsFromReport } from './crap-engine.js';
import { analyzeModule } from './escomplex-kernel.js';
import { Logger } from './Logger.js';
import { scanDirectory } from './maintainability-utils.js';
import {
  prepareSourceForScoring,
  resolveTsTranspilerVersion,
} from './transpile.js';

const CRAP_WORKER_URL = new URL('./workers/crap-worker.js', import.meta.url);

// Overridable per scan via `serialThreshold` (parity tests drive the pool).
const SERIAL_THRESHOLD = POOL_SERIAL_THRESHOLD;
export const KERNEL_VERSION = '1.1.0';
export { resolveTsTranspilerVersion };

const SCHEMA_REF = '.agents/schemas/crap-baseline.schema.json';

/** Stamped as scorer identity: the package that actually computes the metrics. */
const SCORER_PACKAGE = 'escomplex-plugin-metrics-module';

/**
 * Nearest installed `SCORER_PACKAGE` version walking up from `cwd`;
 * `'0.0.0'` (unknown environment) when not found.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveEscomplexVersion(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  const { root } = path.parse(dir);
  while (true) {
    const pkgPath = path.join(
      dir,
      'node_modules',
      SCORER_PACKAGE,
      'package.json',
    );
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (parsed && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        // fall through to parent lookup
      }
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/**
 * Baseline envelope of the scored rows. `tsTranspilerVersion` lets consumers
 * detect TS transpiler drift (`'0.0.0'` when typescript is unresolvable).
 *
 * @param {{
 *   rows: Array<{file: string, method: string, startLine: number, crap: number|null}>,
 *   escomplexVersion: string,
 *   kernelVersion?: string,
 *   tsTranspilerVersion?: string,
 * }} params
 */
export function buildBaselineEnvelope({
  rows,
  escomplexVersion,
  kernelVersion = KERNEL_VERSION,
  tsTranspilerVersion = resolveTsTranspilerVersion(),
}) {
  if (typeof escomplexVersion !== 'string' || !escomplexVersion) {
    throw new TypeError('buildBaselineEnvelope: escomplexVersion is required');
  }
  const scored = (rows ?? []).filter(
    (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
  );
  return {
    $schema: SCHEMA_REF,
    escomplexVersion,
    kernelVersion,
    rows: scored.map((r) => ({
      crap: r.crap,
      file: r.file,
      method: r.method,
      startLine: r.startLine,
      ...(r.anonymous === undefined ? {} : { anonymous: r.anonymous }),
    })),
    tsTranspilerVersion,
  };
}

/**
 * "Tests never reached this method" scores 0% coverage; "no coverage run at
 * all" is absent, not 0% (which would fail untouched files). Carried per queue
 * item because pool workers only see their own file's entry.
 *
 * @param {object|null|undefined} coverage Parsed `coverage-final.json` map.
 * @returns {boolean}
 */
function isCoverageArtifactPresent(coverage) {
  return coverage !== null && coverage !== undefined;
}

const WORST_OFFENDER_LIMIT = 5;

/**
 * Method-resolution counters that make a broken coverage join visible. Only
 * files with a coverage entry count: an untouched file has no join to fail.
 */
function newResolutionAccumulator() {
  return { resolved: 0, total: 0, byFile: [] };
}

function accumulateResolution(acc, relPath, result) {
  if (result?.hasCoverageEntry !== true) return;
  const total = result.totalMethods ?? 0;
  if (total === 0) return;
  const resolved = result.resolvedMethods ?? 0;
  acc.resolved += resolved;
  acc.total += total;
  if (resolved < total) {
    acc.byFile.push({ file: relPath, unresolved: total - resolved, total });
  }
}

function summarizeResolution(acc) {
  const worstFiles = [...acc.byFile]
    .sort((a, b) => b.unresolved - a.unresolved || a.file.localeCompare(b.file))
    .slice(0, WORST_OFFENDER_LIMIT);
  return {
    resolvedMethods: acc.resolved,
    joinableMethods: acc.total,
    rate: acc.total === 0 ? 1 : acc.resolved / acc.total,
    worstFiles,
  };
}

/** Below this sample (e.g. a small diff scope) the rate is not enforced. */
const MIN_RESOLUTION_SAMPLE = 25;

/**
 * Fail-closed guard on the coverage join: a thin result refuses the write.
 * Returns `null` to proceed, or the refusal message.
 *
 * @param {{resolvedMethods: number, joinableMethods: number, rate: number,
 *   worstFiles: Array<{file: string, unresolved: number, total: number}>}
 *   | undefined} resolution
 * @param {number} floor
 * @returns {string|null}
 */
export function checkResolutionFloor(resolution, floor) {
  if (!resolution) return null;
  const { joinableMethods = 0, resolvedMethods = 0, rate = 1 } = resolution;
  if (joinableMethods < MIN_RESOLUTION_SAMPLE) return null;
  if (rate >= floor) return null;
  const worst = (resolution.worstFiles ?? [])
    .map((w) => `         - ${w.file} (${w.unresolved}/${w.total} unresolved)`)
    .join('\n');
  return (
    `[CRAP] Refusing to persist: only ${resolvedMethods}/${joinableMethods} ` +
    `method(s) (${(rate * 100).toFixed(1)}%) resolved a coverage entry in files ` +
    `that HAVE coverage — below the ${(floor * 100).toFixed(1)}% floor ` +
    '(delivery.quality.gates.crap.minMethodResolutionRate).\n' +
    '       A baseline built from a broken join is not sparse, it is wrong: ' +
    'unresolved methods are absent and coincidental line collisions are ' +
    'mis-attributed.\n' +
    (worst ? `       Worst unresolved files:\n${worst}\n` : '') +
    "       Regenerate coverage ('npm run test:coverage') and re-run; if the " +
    'rate stays low the coverage artifact and the scanned tree disagree.'
  );
}

/**
 * Parse once, deriving both MI and CRAP rows. Unresolvable coverage yields
 * `coverage: null, crap: null` rows.
 *
 * @param {string} source Prepared (possibly transpiled) JavaScript source text.
 * @param {object|null} coverageForFile Istanbul coverage entry for this file.
 * @param {((line: number) => number|null)|null} [mapLine] Transpiled →
 *   original line resolver; `null` for JavaScript.
 * @returns {{
 *   report: object,
 *   miScore: number,
 *   crapRows: Array<{
 *     method: string,
 *     startLine: number,
 *     cyclomatic: number,
 *     coverage: number|null,
 *     crap: number|null,
 *   }>,
 *   parseError: boolean,
 * }}
 */
function analyzeOnce(source, coverageForFile, mapLine = null) {
  let report;
  try {
    report = analyzeModule(source);
  } catch {
    return { report: null, miScore: 0, crapRows: [], parseError: true };
  }
  const miScore =
    typeof report.maintainability === 'number' ? report.maintainability : 0;
  const crapRows = methodRowsFromReport(report, coverageForFile, mapLine);
  return { report, miScore, crapRows, parseError: false };
}

/**
 * Per-file work queue, scoped by `scopeSet`. Paths are canonicalised so a
 * scan from inside `.worktrees/<ws>/` never leaks that prefix into baselines.
 *
 * @param {string[]} files Absolute paths, already sorted.
 * @param {{
 *   cwd: string,
 *   scopeSet: Set<string>|null,
 *   requireCoverage: boolean,
 *   coverageAvailable: boolean,
 *   incrementalCtx: object,
 * }} opts
 * @returns {Array<object>}
 */
function buildScanQueue(
  files,
  { cwd, scopeSet, requireCoverage, coverageAvailable, incrementalCtx },
) {
  const queue = [];
  for (const abs of files) {
    const rawRel = path.relative(cwd, abs).replace(/\\/g, '/');
    const relPath = canonicalisePath(rawRel);
    if (scopeSet && !scopeSet.has(relPath)) continue;
    queue.push(
      resolveQueueIncrementalFields(
        { abs, relPath, requireCoverage, coverageAvailable },
        incrementalCtx,
      ),
    );
  }
  return queue;
}

/**
 * @param {string} relPath Canonical repo-relative path of the scanned file.
 * @param {object} mr A row from `finalizeMethodRowsWithBaseline`.
 * @returns {object}
 */
function projectScanRow(relPath, mr) {
  return {
    file: relPath,
    method: mr.method,
    // `method` may be a derived anonymous identity.
    anonymous: mr.anonymous === true,
    startLine: mr.startLine,
    cyclomatic: mr.cyclomatic,
    coverage: mr.coverage,
    crap: mr.crap,
    coordinateSystem: mr.coordinateSystem ?? COORDINATE_ORIGINAL,
    // Present only when true, so a full-scope scan's rows are unaffected.
    ...(mr.resolvedFromBaseline === true ? { resolvedFromBaseline: true } : {}),
  };
}

/**
 * Score every method under `targetDirs` (no disk writes). Files without
 * coverage are skipped under `requireCoverage`; methods without resolvable
 * coverage are always dropped, so baselines never hold partial rows. A file
 * that cannot be read, transpiled or parsed is counted in `unscorableFiles`
 * so no drop is silent. `scopeFiles` filters before any I/O;
 * `preScannedFiles` skips the walk; `incremental` resolves untouched files
 * from the baseline instead of fresh coverage.
 *
 * @param {{
 *   targetDirs: string[],
 *   coverage: object|null,
 *   requireCoverage?: boolean,
 *   cwd?: string,
 *   scopeFiles?: Set<string>|string[]|null,
 *   preScannedFiles?: string[]|null,
 *   incremental?: { touchedFiles: Set<string>|string[], baselineRows: Array<object> } | null,
 * }} params
 * @returns {{
 *   rows: Array<{
 *     file: string,
 *     method: string,
 *     startLine: number,
 *     cyclomatic: number,
 *     coverage: number,
 *     crap: number,
 *   }>,
 *   scannedFiles: number,
 *   skippedFilesNoCoverage: number,
 *   skippedMethodsNoCoverage: number,
 *   unscorableFiles: number,
 * }}
 */
export async function scanAndScore({
  targetDirs,
  coverage,
  requireCoverage = true,
  cwd = process.cwd(),
  scopeFiles = null,
  ignoreGlobs = [],
  preScannedFiles = null,
  incremental = null,
  serialThreshold = SERIAL_THRESHOLD,
}) {
  if (!Array.isArray(targetDirs)) {
    throw new TypeError('scanAndScore: targetDirs must be an array');
  }
  const scopeSet =
    scopeFiles == null
      ? null
      : scopeFiles instanceof Set
        ? scopeFiles
        : new Set(scopeFiles);
  const files = preScannedFiles != null ? [...preScannedFiles] : [];
  if (preScannedFiles == null) {
    for (const dir of targetDirs) {
      const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
      scanDirectory(abs, files, { cwd, ignoreGlobs });
    }
  }
  files.sort();

  const incrementalCtx = resolveIncrementalContext(incremental);

  const queue = buildScanQueue(files, {
    cwd,
    scopeSet,
    requireCoverage,
    coverageAvailable: isCoverageArtifactPresent(coverage),
    incrementalCtx,
  });
  const scannedFiles = queue.length;

  // Always serial in incremental mode: the baseline Maps don't cross workers.
  const runSerial = queue.length < serialThreshold || Boolean(incremental);
  const perFile = runSerial
    ? queue.map((item) => ({ item, result: scoreFileSerial(item, coverage) }))
    : await scoreFilesViaPool(queue, coverage);

  const rows = [];
  let skippedFilesNoCoverage = 0;
  let skippedMethodsNoCoverage = 0;
  let unscorableFiles = 0;
  const resolution = newResolutionAccumulator();
  for (const { item, result } of perFile) {
    if (!result) {
      // Pool-level error the worker never answered.
      unscorableFiles += 1;
      continue;
    }
    if (result.skippedFileNoCoverage) {
      skippedFilesNoCoverage += 1;
      continue;
    }
    if (result.rows === null) {
      unscorableFiles += 1;
      if (result.error) {
        Logger.warn(
          `[crap-utils] failed to score ${item.relPath}: ${result.error}`,
        );
      }
      continue;
    }
    skippedMethodsNoCoverage += result.skippedMethodsNoCoverage ?? 0;
    accumulateResolution(resolution, item.relPath, result);
    for (const mr of result.rows) {
      rows.push(projectScanRow(item.relPath, mr));
    }
  }

  rows.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return 0;
  });

  return {
    rows,
    scannedFiles,
    skippedFilesNoCoverage,
    skippedMethodsNoCoverage,
    unscorableFiles,
    resolution: summarizeResolution(resolution),
  };
}

/** In-process scorer; the reference the worker output must match exactly. */
function scoreFileSerial(
  {
    abs,
    relPath,
    requireCoverage,
    coverageAvailable = true,
    touched = true,
    baselineByKey = null,
  },
  coverage,
) {
  const entry = findCoverageEntry(coverage, relPath);
  if (
    shouldSkipFileForNoCoverage(requireCoverage, entry, touched, baselineByKey)
  ) {
    return {
      skippedFileNoCoverage: true,
      rows: [],
      skippedMethodsNoCoverage: 0,
      hasCoverageEntry: false,
      resolvedMethods: 0,
      totalMethods: 0,
    };
  }
  const dropped = {
    skippedFileNoCoverage: false,
    rows: null,
    skippedMethodsNoCoverage: 0,
    hasCoverageEntry: entry !== null,
    resolvedMethods: 0,
    totalMethods: 0,
  };
  const prepared = prepareSourceForScoring(abs);
  if (prepared.error) return dropped;
  const { crapRows, parseError } = analyzeOnce(
    prepared.code,
    entry,
    prepared.mapLine,
  );
  if (parseError) return dropped;
  const finalized = finalizeMethodRowsWithBaseline(crapRows, {
    requireCoverage,
    coverageAvailable,
    touched,
    baselineByKey,
  });
  return {
    skippedFileNoCoverage: false,
    hasCoverageEntry: entry !== null,
    ...finalized,
  };
}

async function scoreFilesViaPool(queue, coverage) {
  // Send each worker only its file's entry, not the whole coverage map.
  const enrichedQueue = queue.map((item) => ({
    ...item,
    coverageEntry: findCoverageEntry(coverage, item.relPath),
  }));
  const results = await runOnPool(CRAP_WORKER_URL, enrichedQueue, {
    workerData: {},
  });
  return results.map((r, i) => {
    const item = queue[i];
    if (!r || r.__cpuPoolError) {
      Logger.warn(
        `[crap-utils] worker pool error for ${item.relPath}: ${r?.message ?? 'unknown'}`,
      );
      return { item, result: null };
    }
    return { item, result: r };
  });
}
