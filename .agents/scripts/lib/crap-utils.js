import fs from 'node:fs';
import path from 'node:path';
import escomplex from 'typhonjs-escomplex';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import {
  coverageForMethodInEntry,
  findCoverageEntry,
} from './coverage-utils.js';
import { POOL_SERIAL_THRESHOLD, runOnPool } from './cpu-pool.js';
import { crapFormula } from './crap-engine.js';
import { Logger } from './Logger.js';
import { scanDirectory } from './maintainability-utils.js';
import { resolveTsTranspilerVersion, transpileIfNeeded } from './transpile.js';

const CRAP_WORKER_URL = new URL('./workers/crap-worker.js', import.meta.url);
const COMBINED_MI_CRAP_WORKER_URL = new URL(
  './workers/combined-mi-crap-worker.js',
  import.meta.url,
);

// Pool-vs-serial cutover — single-sourced in cpu-pool.js (see the
// POOL_SERIAL_THRESHOLD docstring for the tuning rationale).
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

function resolveBaselinePath({ cwd = process.cwd(), baselinePath } = {}) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new TypeError(
      'crap-utils: opts.baselinePath is required (Epic #730 Story 5.5 — ' +
        'callers resolve the path via getBaselines(config).crap.path).',
    );
  }
  return path.isAbsolute(baselinePath)
    ? baselinePath
    : path.join(cwd, baselinePath);
}

/**
 * Load the CRAP baseline envelope from disk.
 *
 * Returns the parsed envelope on success, or `null` when the file is missing,
 * unreadable, or structurally unusable. Version-mismatch detection is a
 * caller concern — this loader never silently rescores or mutates the
 * envelope.
 *
 * @param {{cwd?: string, baselinePath?: string}} [opts]
 * @returns {{
 *   kernelVersion: string,
 *   escomplexVersion: string,
 *   rows: Array<{file: string, method: string, startLine: number, crap: number}>,
 * }|null}
 */
/**
 * Story #1895: shipped baseline switched to the canonical envelope shape
 * (`$schema`, `kernelVersion`, `generatedAt`, `rollup`, `rows` keyed on
 * `path`). Backfill the legacy `escomplexVersion`/`tsTranspilerVersion`
 * version fields from the running scorer and re-key rows by `file` so
 * existing comparators keep working until Story #1912 lands the unified
 * gate. Detection probes the first row for the new `path` key — the
 * legacy envelope also carries `$schema` but keys rows by `file`.
 */
function projectCrapEnvelopeToLegacy(parsed) {
  if (
    !Array.isArray(parsed.rows) ||
    parsed.rows.length === 0 ||
    typeof parsed.rows[0]?.path !== 'string'
  ) {
    return null;
  }
  return {
    kernelVersion: parsed.kernelVersion,
    escomplexVersion: resolveEscomplexVersion(),
    tsTranspilerVersion: resolveTsTranspilerVersion(),
    rows: parsed.rows.map((row) => ({
      crap: row.crap,
      file: row.path,
      method: row.method,
      startLine: row.startLine,
    })),
  };
}

export function getCrapBaseline(opts = {}) {
  const filePath = resolveBaselinePath(opts);
  if (!fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    Logger.warn(`[crap-utils] unable to read baseline: ${err.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    Logger.warn(`[crap-utils] baseline is not valid JSON: ${err.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const projected = projectCrapEnvelopeToLegacy(parsed);
  if (projected) return projected;
  if (typeof parsed.kernelVersion !== 'string') return null;
  if (typeof parsed.escomplexVersion !== 'string') return null;
  if (!Array.isArray(parsed.rows)) return null;
  // tsTranspilerVersion landed in kernel 1.1.0. Older envelopes (1.0.0)
  // do not carry it; we surface that as the sentinel '0.0.0' so the
  // version-drift detector can warn on first 1.1.0 check without
  // crashing on a missing field.
  if (typeof parsed.tsTranspilerVersion !== 'string') {
    parsed.tsTranspilerVersion = '0.0.0';
  }
  return parsed;
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
    })),
    tsTranspilerVersion,
  };
}

/**
 * Parse `source` exactly once with escomplex and derive both the
 * maintainability score and the raw CRAP method rows from that single report.
 *
 * Callers that need both scores for the same source string (e.g. a combined
 * CRAP + MI scan) MUST use this helper rather than calling `calculateCrapForSource`
 * and `calculateForSource` separately — doing so would parse the AST twice.
 *
 * Coverage-dependent CRAP values require a `coverageForFile` entry (the value
 * from `coverage-final.json` for this file). Pass `null` when no coverage is
 * available; method rows whose coverage cannot be resolved will carry
 * `coverage: null` and `crap: null`.
 *
 * @param {string} source Prepared (possibly transpiled) JavaScript source text.
 * @param {object|null} coverageForFile Istanbul coverage entry for this file.
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
export function analyzeOnce(source, coverageForFile) {
  let report;
  try {
    report = escomplex.analyzeModule(source);
  } catch {
    return { report: null, miScore: 0, crapRows: [], parseError: true };
  }
  const miScore =
    typeof report.maintainability === 'number' ? report.maintainability : 0;
  const methods = report?.methods ?? [];
  const crapRows = [];
  for (const m of methods) {
    const startLine = m?.lineStart;
    if (typeof startLine !== 'number') continue;
    const cyclomatic = m?.cyclomatic ?? 0;
    const coverage = coverageForFile
      ? coverageForMethodInEntry(coverageForFile, startLine)
      : null;
    const crap = coverage === null ? null : crapFormula(cyclomatic, coverage);
    crapRows.push({ method: m.name, startLine, cyclomatic, coverage, crap });
  }
  return { report, miScore, crapRows, parseError: false };
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
 * @param {{
 *   targetDirs: string[],
 *   coverage: object|null,
 *   requireCoverage?: boolean,
 *   cwd?: string,
 *   scopeFiles?: Set<string>|string[]|null,
 *   preScannedFiles?: string[]|null,
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

  // Build the work-queue first so scopeFile filtering happens before
  // any I/O / IPC. `scannedFiles` is the in-scope count.
  // Story #2079: route every relPath through path-canon so a scan from
  // inside `.worktrees/<workspace>/` (with cwd pointing at the main
  // checkout) cannot leak the worktree prefix into the on-disk baseline's
  // `file` / `path` keys downstream.
  const queue = [];
  for (const abs of files) {
    const rawRel = path.relative(cwd, abs).replace(/\\/g, '/');
    const relPath = canonicalisePath(rawRel);
    if (scopeSet && !scopeSet.has(relPath)) continue;
    queue.push({ abs, relPath, requireCoverage });
  }
  const scannedFiles = queue.length;

  const perFile =
    queue.length < SERIAL_THRESHOLD
      ? queue.map((item) => ({ item, result: scoreFileSerial(item, coverage) }))
      : await scoreFilesViaPool(queue, coverage);

  const rows = [];
  let skippedFilesNoCoverage = 0;
  let skippedMethodsNoCoverage = 0;
  for (const { item, result } of perFile) {
    if (!result) continue; // unrecoverable per-file failure: drop silently to match pre-pool semantics
    if (result.skippedFileNoCoverage) {
      skippedFilesNoCoverage += 1;
      continue;
    }
    if (result.rows === null) {
      // read/transpile/parse failure: drop and move on, but if the worker
      // attached an error message (calculateCrapForSource throw) surface it
      // so the run isn't silent on the ops side.
      if (result.error) {
        Logger.warn(
          `[crap-utils] failed to score ${item.relPath}: ${result.error}`,
        );
      }
      continue;
    }
    skippedMethodsNoCoverage += result.skippedMethodsNoCoverage ?? 0;
    for (const mr of result.rows) {
      rows.push({
        file: item.relPath,
        method: mr.method,
        startLine: mr.startLine,
        cyclomatic: mr.cyclomatic,
        coverage: mr.coverage,
        crap: mr.crap,
      });
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
  };
}

/**
 * In-process scorer used by both the small-batch fast path and as the
 * reference implementation against which the worker output is asserted
 * byte-for-byte in the cpu-pool tests.
 *
 * Uses `analyzeOnce` so the source is parsed a single time and both the
 * CRAP rows and the MI score are derived from the same escomplex report.
 */
function scoreFileSerial({ abs, relPath, requireCoverage }, coverage) {
  const entry = findCoverageEntry(coverage, relPath);
  if (requireCoverage && entry === null) {
    return {
      skippedFileNoCoverage: true,
      rows: [],
      skippedMethodsNoCoverage: 0,
    };
  }
  let source;
  try {
    source = fs.readFileSync(abs, 'utf-8');
  } catch {
    return {
      skippedFileNoCoverage: false,
      rows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  const prepared = transpileIfNeeded(abs, source);
  if (prepared === null) {
    return {
      skippedFileNoCoverage: false,
      rows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  const { crapRows, parseError } = analyzeOnce(prepared, entry);
  if (parseError) {
    return {
      skippedFileNoCoverage: false,
      rows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  const rows = [];
  let skippedMethodsNoCoverage = 0;
  for (const mr of crapRows) {
    if (mr.crap === null || mr.coverage === null) {
      skippedMethodsNoCoverage += 1;
      continue;
    }
    rows.push({
      method: mr.method,
      startLine: mr.startLine,
      cyclomatic: mr.cyclomatic,
      coverage: mr.coverage,
      crap: mr.crap,
    });
  }
  return { skippedFileNoCoverage: false, rows, skippedMethodsNoCoverage };
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

/**
 * In-process combined scorer: parse `abs` exactly once via `analyzeOnce` and
 * derive BOTH the module MI score and the per-method CRAP rows. The reference
 * implementation for the combined worker, used directly below
 * `SERIAL_THRESHOLD` (matching the serial fast paths of `calculateAll` and
 * `scanAndScore`).
 *
 * Return shape mirrors `combined-mi-crap-worker.js`:
 *   - `miScore` — `null` on read failure (MI dropped by the host), `0` on
 *     transpile-null / parse-error (parity with `calculateForFile` /
 *     `calculateForSource`), otherwise the module maintainability index.
 *   - `crapRows` — `null` on read/transpile/parse failure (CRAP drops the
 *     file), `[]` when coverage-skipped, otherwise the scored method rows.
 *   - `skippedFileNoCoverage` / `skippedMethodsNoCoverage` — CRAP counters.
 */
function scoreFileCombinedSerial({ abs, relPath, requireCoverage }, coverage) {
  const entry = findCoverageEntry(coverage, relPath);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf-8');
  } catch {
    return {
      relPath,
      miScore: null,
      skippedFileNoCoverage: false,
      crapRows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  const prepared = transpileIfNeeded(abs, source);
  if (prepared === null) {
    return {
      relPath,
      miScore: 0,
      skippedFileNoCoverage: false,
      crapRows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  const {
    miScore,
    crapRows: rawCrapRows,
    parseError,
  } = analyzeOnce(prepared, entry);
  if (parseError) {
    return {
      relPath,
      miScore: 0,
      skippedFileNoCoverage: false,
      crapRows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  if (requireCoverage && entry === null) {
    return {
      relPath,
      miScore,
      skippedFileNoCoverage: true,
      crapRows: [],
      skippedMethodsNoCoverage: 0,
    };
  }
  const crapRows = [];
  let skippedMethodsNoCoverage = 0;
  for (const mr of rawCrapRows) {
    if (mr.crap === null || mr.coverage === null) {
      skippedMethodsNoCoverage += 1;
      continue;
    }
    crapRows.push({
      method: mr.method,
      startLine: mr.startLine,
      cyclomatic: mr.cyclomatic,
      coverage: mr.coverage,
      crap: mr.crap,
    });
  }
  return {
    relPath,
    miScore,
    skippedFileNoCoverage: false,
    crapRows,
    skippedMethodsNoCoverage,
  };
}

async function scoreFilesCombinedViaPool(queue, coverage) {
  const enrichedQueue = queue.map((item) => ({
    ...item,
    coverageEntry: findCoverageEntry(coverage, item.relPath),
  }));
  const results = await runOnPool(COMBINED_MI_CRAP_WORKER_URL, enrichedQueue, {
    workerData: {},
  });
  return results.map((r, i) => {
    const item = queue[i];
    if (!r || r.__cpuPoolError) {
      Logger.warn(
        `[crap-utils] combined worker pool error for ${item.relPath}: ${r?.message ?? 'unknown'}`,
      );
      return { item, result: null };
    }
    return { item, result: r };
  });
}

/**
 * Combined MI + CRAP single-pass scan. Walks the shared `targetDirs` once (or
 * reuses `preScannedFiles`), dispatches every file through ONE worker that
 * calls `analyzeOnce` a single time, and returns BOTH the maintainability
 * score map and the CRAP scan result.
 *
 * This collapses the two independent escomplex passes the full-tree baseline
 * regenerator used to run (`calculateAll` → maintainability worker, then
 * `scanAndScore` → CRAP worker) into one parse per file. The outputs are
 * shaped to be drop-in equivalents of the two passes they replace, so the
 * downstream envelope projection + writer logic stays byte-identical:
 *
 *   - `miScores` — `Record<relPath, number>` keyed exactly as `calculateAll`
 *     keys its result (`path.relative(cwd, abs)`, POSIX-normalised), with
 *     read-failure files (`miScore === null`) dropped. Parity target:
 *     `calculateAll(files)`.
 *   - `crap` — `{ rows, scannedFiles, skippedFilesNoCoverage,
 *     skippedMethodsNoCoverage }`, identical in shape and content to
 *     `scanAndScore({ targetDirs, coverage, ... })`. The rows are
 *     CRAP-sorted (file → startLine → method) so the result matches
 *     `scanAndScore` even before the writer re-sorts.
 *
 * The `requireCoverage`, `scopeFiles`, `ignoreGlobs`, and `preScannedFiles`
 * semantics match `scanAndScore` exactly — coverage gating, scope filtering,
 * and the single-walk reuse path behave the same. Files dropped from CRAP by
 * the coverage gate STILL contribute their MI score (the MI pass never
 * required coverage), preserving the two-pass behaviour where MI scores every
 * file in the target dirs.
 *
 * @param {{
 *   targetDirs: string[],
 *   coverage: object|null,
 *   requireCoverage?: boolean,
 *   cwd?: string,
 *   scopeFiles?: Set<string>|string[]|null,
 *   ignoreGlobs?: string[],
 *   preScannedFiles?: string[]|null,
 * }} params
 * @returns {Promise<{
 *   miScores: Record<string, number>,
 *   crap: {
 *     rows: Array<{
 *       file: string, method: string, startLine: number,
 *       cyclomatic: number, coverage: number, crap: number,
 *     }>,
 *     scannedFiles: number,
 *     skippedFilesNoCoverage: number,
 *     skippedMethodsNoCoverage: number,
 *   },
 * }>}
 */
export async function scanAndScoreCombined({
  targetDirs,
  coverage,
  requireCoverage = true,
  cwd = process.cwd(),
  scopeFiles = null,
  ignoreGlobs = [],
  preScannedFiles = null,
}) {
  if (!Array.isArray(targetDirs)) {
    throw new TypeError('scanAndScoreCombined: targetDirs must be an array');
  }
  const scopeSet =
    scopeFiles == null
      ? null
      : scopeFiles instanceof Set
        ? scopeFiles
        : new Set(scopeFiles);

  // Single directory walk (or reuse the caller's pre-walked list), mirroring
  // scanAndScore so the file discovery is byte-identical between paths.
  const files = preScannedFiles != null ? [...preScannedFiles] : [];
  if (preScannedFiles == null) {
    for (const dir of targetDirs) {
      const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
      scanDirectory(abs, files, { cwd, ignoreGlobs });
    }
  }
  files.sort();

  // Build the work queue. Each item carries both the canonicalised relPath
  // (CRAP's key + scope filter, matching scanAndScore) and the raw relPath
  // (MI's key, matching calculateAll's `path.relative(cwd, p)` shape).
  const queue = [];
  for (const abs of files) {
    const rawRel = path.relative(cwd, abs).replace(/\\/g, '/');
    const relPath = canonicalisePath(rawRel);
    if (scopeSet && !scopeSet.has(relPath)) continue;
    queue.push({ abs, relPath, miRel: rawRel, requireCoverage });
  }
  const scannedFiles = queue.length;

  const perFile =
    queue.length < SERIAL_THRESHOLD
      ? queue.map((item) => ({
          item,
          result: scoreFileCombinedSerial(item, coverage),
        }))
      : await scoreFilesCombinedViaPool(queue, coverage);

  // MI assembly — mirror calculateAll: drop read-failure files (miScore
  // null), key by the raw relative path, then sort ascending so the returned
  // object is insertion-order-stable.
  const miEntries = [];
  // CRAP assembly — mirror scanAndScore: file-level skip counter, drop
  // read/transpile/parse failures, accumulate method rows.
  const crapRows = [];
  let skippedFilesNoCoverage = 0;
  let skippedMethodsNoCoverage = 0;

  for (const { item, result } of perFile) {
    if (!result) continue; // unrecoverable per-file failure: drop silently

    // MI side.
    if (result.miScore !== null) {
      miEntries.push({ relPath: item.miRel, score: result.miScore });
    }

    // CRAP side.
    if (result.skippedFileNoCoverage) {
      skippedFilesNoCoverage += 1;
      continue;
    }
    if (result.crapRows === null) {
      if (result.error) {
        Logger.warn(
          `[crap-utils] failed to score ${item.relPath}: ${result.error}`,
        );
      }
      continue;
    }
    skippedMethodsNoCoverage += result.skippedMethodsNoCoverage ?? 0;
    for (const mr of result.crapRows) {
      crapRows.push({
        file: item.relPath,
        method: mr.method,
        startLine: mr.startLine,
        cyclomatic: mr.cyclomatic,
        coverage: mr.coverage,
        crap: mr.crap,
      });
    }
  }

  miEntries.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const miScores = {};
  for (const { relPath, score } of miEntries) {
    miScores[relPath] = score;
  }

  crapRows.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return 0;
  });

  return {
    miScores,
    crap: {
      rows: crapRows,
      scannedFiles,
      skippedFilesNoCoverage,
      skippedMethodsNoCoverage,
    },
  };
}
