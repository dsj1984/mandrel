import fs from 'node:fs';
import path from 'node:path';
import { findCoverageEntry } from './coverage-utils.js';
import { runOnPool } from './cpu-pool.js';
import { calculateCrapForSource } from './crap-engine.js';
import { Logger } from './Logger.js';
import {
  resolveTsTranspilerVersion,
  scanDirectory,
  transpileIfNeeded,
} from './maintainability-utils.js';

const CRAP_WORKER_URL = new URL('./workers/crap-worker.js', import.meta.url);

// Below this batch size the pool's spawn overhead dominates — fall
// back to in-process serial scoring. The full repo (~200+ files)
// always takes the pool path; tests with handful-of-files fixtures
// stay serial and remain byte-identical to the pre-pool output.
const SERIAL_THRESHOLD = 8;
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

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return 0;
  });
}

function canonicalizeRow(row) {
  return {
    crap: row.crap,
    file: row.file,
    method: row.method,
    startLine: row.startLine,
  };
}

function canonicalizeEnvelope(envelope) {
  const ordered = {};
  ordered.$schema = envelope.$schema ?? SCHEMA_REF;
  ordered.escomplexVersion = envelope.escomplexVersion;
  ordered.kernelVersion = envelope.kernelVersion;
  ordered.rows = sortRows(envelope.rows).map(canonicalizeRow);
  ordered.tsTranspilerVersion = envelope.tsTranspilerVersion ?? '0.0.0';
  return ordered;
}

/**
 * Project rich scan rows onto the minimal baseline row shape and assemble an
 * envelope ready for `saveCrapBaseline`.
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
 * Serialize an envelope to disk with deterministic ordering.
 *
 * Rows are sorted by `(file, startLine, method)`, top-level and row keys are
 * alphabetized, and the file terminates with a trailing newline — so a
 * re-save of the same logical envelope is byte-identical across runs and
 * platforms.
 *
 * @param {object} envelope
 * @param {{cwd?: string, baselinePath?: string}} [opts]
 */
export function saveCrapBaseline(envelope, opts = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('saveCrapBaseline: envelope must be an object');
  }
  const canonical = canonicalizeEnvelope(envelope);
  const filePath = resolveBaselinePath(opts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(canonical, null, 2)}\n`);
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
 * @param {{
 *   targetDirs: string[],
 *   coverage: object|null,
 *   requireCoverage?: boolean,
 *   cwd?: string,
 *   scopeFiles?: Set<string>|string[]|null,
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
  const files = [];
  for (const dir of targetDirs) {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    scanDirectory(abs, files);
  }
  files.sort();

  // Build the work-queue first so scopeFile filtering happens before
  // any I/O / IPC. `scannedFiles` is the in-scope count.
  const queue = [];
  for (const abs of files) {
    const relPath = path.relative(cwd, abs).replace(/\\/g, '/');
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
  let methodRows;
  try {
    methodRows = calculateCrapForSource(prepared, entry);
  } catch {
    return {
      skippedFileNoCoverage: false,
      rows: null,
      skippedMethodsNoCoverage: 0,
    };
  }
  const rows = [];
  let skippedMethodsNoCoverage = 0;
  for (const mr of methodRows) {
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
  const results = await runOnPool(CRAP_WORKER_URL, queue, {
    workerData: { coverage },
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
