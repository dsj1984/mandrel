import fs from 'node:fs';
import path from 'node:path';
import escomplex from 'typhonjs-escomplex';
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
import { Logger } from './Logger.js';
import { scanDirectory } from './maintainability-utils.js';
import {
  prepareSourceForScoring,
  resolveTsTranspilerVersion,
} from './transpile.js';

const CRAP_WORKER_URL = new URL('./workers/crap-worker.js', import.meta.url);

// Pool-vs-serial cutover — single-sourced in cpu-pool.js (see the
// POOL_SERIAL_THRESHOLD docstring for the tuning rationale). Callers may
// override it per scan via `serialThreshold`, which is how the parity tests
// drive the pooled path without materialising a batch bigger than the
// cutover (Story #5109 raised it from 8 to 256).
const SERIAL_THRESHOLD = POOL_SERIAL_THRESHOLD;
// 1.1.0 — TypeScript support landed in 5.29.0. Bumped from 1.0.0 because
// the scanner now emits CRAP rows for TS/TSX paths that the previous
// kernel could never reach. The CRAP formula and per-method scoring
// shape are unchanged for JS sources.
export const KERNEL_VERSION = '1.1.0';
export { resolveTsTranspilerVersion };

const SCHEMA_REF = '.agents/schemas/crap-baseline.schema.json';

/**
 * Resolve the running `typhonjs-escomplex` version by walking up from `cwd`
 * and reading the nearest `node_modules/typhonjs-escomplex/package.json`.
 * Returns `'0.0.0'` when the dependency cannot be found — callers treat that
 * sentinel as "unknown environment" and may refuse to persist a baseline.
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
      'typhonjs-escomplex',
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
 * Project rich scan rows onto the minimal baseline row shape and assemble an
 * envelope ready for the shared V2 writer.
 *
 * `tsTranspilerVersion` stamps the resolved `typescript` package version so
 * consumers can detect transpiler drift on TS rows. Defaults to the
 * sentinel `'0.0.0'` when typescript is unresolvable — drift detection
 * then becomes a no-op rather than failing the bake.
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
 * True when a coverage artifact was actually loaded for this scan.
 *
 * Story #4871: "the tests ran and never reached this method" is a measurement
 * and the CRAP formula's 0%-covered arm is the right answer for it. "No
 * coverage run happened at all" — a freshly initialized story worktree with no
 * `coverage/` directory — is an *absent* observation, and filling it with 0%
 * drives every method to `c² + c`, failing the first commit on files the
 * change never touched. Resolved once per scan and carried on each queue item
 * so the pool workers, which only ever receive their own file's coverage
 * entry, can still tell the two apart.
 *
 * @param {object|null|undefined} coverage Parsed `coverage-final.json` map.
 * @returns {boolean}
 */
function isCoverageArtifactPresent(coverage) {
  return coverage !== null && coverage !== undefined;
}

/**
 * How many files to name when reporting the worst unresolved offenders. Long
 * enough to point at a pattern, short enough to stay a readable CLI message.
 */
const WORST_OFFENDER_LIMIT = 5;

/**
 * Method-resolution telemetry (Story #4775, fix part 4).
 *
 * The updater used to persist a 100-row baseline built from 5023 dropped
 * methods and log it as success — the rot that let a broken coverage join
 * sit undetected for five weeks across three repos. These three helpers
 * carry the counters that make a thin result *visible* and therefore
 * refusable.
 *
 * The rate is deliberately measured over files that **do** have a coverage
 * entry: a file the test run never touched has no join to fail, so counting
 * it would dilute the signal the floor is meant to catch.
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

/**
 * Minimum number of joinable methods before the resolution-rate floor is
 * enforced. A diff-scoped run can legitimately touch a handful of methods,
 * where one unresolved method is a 50% rate and says nothing about the health
 * of the join. Below this sample the rate is reported, never enforced.
 */
const MIN_RESOLUTION_SAMPLE = 25;

/**
 * Fail-closed guard on the per-method coverage join (Story #4775, fix part 4).
 *
 * The updater used to persist a 100-row baseline distilled from 5023 dropped
 * methods and log it as a success — which is exactly how a broken join stayed
 * invisible for five weeks across three repositories. A thin result is now a
 * refusal: the caller throws before anything is written, and the message names
 * the rate, the counts, and the files carrying the most unresolved methods so
 * the operator can tell "my tests do not cover that" apart from "the join is
 * broken".
 *
 * Returns `null` when the run may proceed, or the operator-facing message when
 * it must not.
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
 * Parse `source` exactly once with escomplex and derive both the
 * maintainability score and the raw CRAP method rows from that single report.
 *
 * Callers that need both scores for the same source string MUST use this
 * helper rather than calling `calculateCrapForSource` and `calculateForSource`
 * separately — doing so would parse the AST twice.
 *
 * Coverage-dependent CRAP values require a `coverageForFile` entry (the value
 * from `coverage-final.json` for this file). Pass `null` when no coverage is
 * available; method rows whose coverage cannot be resolved will carry
 * `coverage: null` and `crap: null`.
 *
 * @param {string} source Prepared (possibly transpiled) JavaScript source text.
 * @param {object|null} coverageForFile Istanbul coverage entry for this file.
 * @param {((line: number) => number|null)|null} [mapLine] Transpiled →
 *   original-source line resolver from `transpileIfNeeded(…, {withLineMap:
 *   true})`; `null` for JavaScript, whose coordinates already match the
 *   coverage entry's.
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
    report = escomplex.analyzeModule(source);
  } catch {
    return { report: null, miScore: 0, crapRows: [], parseError: true };
  }
  const miScore =
    typeof report.maintainability === 'number' ? report.maintainability : 0;
  const crapRows = methodRowsFromReport(report, coverageForFile, mapLine);
  return { report, miScore, crapRows, parseError: false };
}

/**
 * Build `scanAndScore`'s per-file work queue: canonicalise each discovered
 * absolute path, drop everything outside `scopeSet`, and merge the
 * incremental-join fields onto the surviving items.
 *
 * Story #2079: every relPath goes through path-canon so a scan from inside
 * `.worktrees/<workspace>/` (with `cwd` pointing at the main checkout) cannot
 * leak the worktree prefix into the on-disk baseline's `file` / `path` keys.
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
 * Project one finalized method row onto the enriched scan-row shape
 * `compareCrap` and the baseline writer consume.
 *
 * @param {string} relPath Canonical repo-relative path of the scanned file.
 * @param {object} mr A row from `finalizeMethodRowsWithBaseline`.
 * @returns {object}
 */
function projectScanRow(relPath, mr) {
  return {
    file: relPath,
    method: mr.method,
    // Story #4969: `method` may be a derived anonymous identity; the flag is
    // what lets the persisted row say so.
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
 * Scan `targetDirs` for JS files, score each method via the CRAP kernel, and
 * return enriched rows plus skip counters. Does not write to disk.
 *
 * Files without a coverage entry are skipped when `requireCoverage` is `true`
 * (the default); methods whose coverage cannot be resolved are always
 * skipped from the returned rows so the baseline never contains
 * partially-scored entries. Both counters surface for reporting.
 *
 * A file neither path could score at all — unreadable, untranspilable, or one
 * the kernel could not parse — is dropped and counted in `unscorableFiles`
 * (Story #5311). Unscorable is not scored-as-nothing: without this counter a
 * dropped file is indistinguishable from a file with no methods, which is what
 * let a whole parse-failure class leave the baseline silently.
 *
 * When `scopeFiles` is provided (the `--changed-since` code path) files
 * discovered via directory walking are filtered against that set before any
 * I/O or scoring happens — so pre-push / PR-CI runs never pay the
 * parse-and-score cost on untouched files.
 *
 * When `preScannedFiles` is provided (an array of absolute paths already
 * collected by a prior `scanDirectory` pass over the same `targetDirs`), the
 * directory walk is skipped entirely — the supplied list is used as-is.
 * Callers that run both CRAP and MI passes over the same target dirs (e.g.
 * `regenerateMainFromTree`) SHOULD pass the MI scan's file list here so the
 * tree is walked only once per run.
 *
 * `incremental` (Story #4981) resolves an untouched file's methods from
 * `crap-baseline-join.js#finalizeMethodRowsWithBaseline` instead of
 * requiring fresh coverage; omitted (the default), behaviour is unchanged.
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
  // When the caller supplies a pre-walked file list (e.g. from a prior MI
  // scan over the same target dirs), skip the directory walk entirely.
  const files = preScannedFiles != null ? [...preScannedFiles] : [];
  if (preScannedFiles == null) {
    for (const dir of targetDirs) {
      const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
      scanDirectory(abs, files, { cwd, ignoreGlobs });
    }
  }
  files.sort();

  const incrementalCtx = resolveIncrementalContext(incremental);

  // Build the work-queue first so scopeFile filtering happens before
  // any I/O / IPC. `scannedFiles` is the in-scope count.
  const queue = buildScanQueue(files, {
    cwd,
    scopeSet,
    requireCoverage,
    coverageAvailable: isCoverageArtifactPresent(coverage),
    incrementalCtx,
  });
  const scannedFiles = queue.length;

  // Serial below the pool cutover, and ALWAYS in incremental mode: the
  // per-file baseline lookup Maps the join needs do not cross the worker
  // boundary (Story #4981).
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
      // Unrecoverable per-file failure (a pool-level error the worker never
      // answered). Dropped like any other unscorable file, and counted — the
      // point of the counter is that no drop is silent.
      unscorableFiles += 1;
      continue;
    }
    if (result.skippedFileNoCoverage) {
      skippedFilesNoCoverage += 1;
      continue;
    }
    if (result.rows === null) {
      // read/transpile/parse failure: drop and move on, but if the worker
      // attached an error message (calculateCrapForSource throw) surface it
      // so the run isn't silent on the ops side.
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

/**
 * In-process scorer used by both the small-batch fast path and as the
 * reference implementation against which the worker output is asserted
 * byte-for-byte in the cpu-pool tests.
 *
 * Uses `analyzeOnce` so the source is parsed a single time.
 */
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
  // Resolve each file's coverage entry on the host before dispatch so workers
  // receive only their file's entry rather than the whole map. This removes the
  // O(workers × coverageMapSize) structured-clone at spawn time.
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
