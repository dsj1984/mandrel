import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import {
  write as writeBaselineEnvelope,
  writeFile as writeBaselineFile,
} from './baselines/writer.js';
import { runOnPool } from './cpu-pool.js';
import { Logger } from './Logger.js';
import { calculateForFile } from './maintainability-engine.js';

const require = createRequire(import.meta.url);

const MAINTAINABILITY_WORKER_URL = new URL(
  './workers/maintainability-worker.js',
  import.meta.url,
);

// Below this batch size the pool's spawn overhead dominates — fall back
// to in-process serial scoring for `--changed-since` runs that touch
// only a handful of files. Tuned against the test suite's tmpdir
// fixtures (n=2 stays serial; the full repo n≈470 takes the pool path).
const SERIAL_THRESHOLD = 8;

const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SUPPORTED_EXTS = new Set([...JS_EXTS, ...TS_EXTS]);

let _ts = null;
let _tsLoadFailed = false;

function loadTypeScript() {
  if (_ts) return _ts;
  if (_tsLoadFailed) return null;
  try {
    _ts = require('typescript');
    return _ts;
  } catch {
    _tsLoadFailed = true;
    return null;
  }
}

/**
 * Resolve the `typescript` package version, used to stamp baselines so
 * consumers can detect transpiler drift. Returns `'0.0.0'` when the
 * dependency is unresolvable — callers treat that sentinel as "unknown
 * environment" and may refuse to persist a baseline that includes TS rows.
 *
 * @returns {string}
 */
export function resolveTsTranspilerVersion() {
  const ts = loadTypeScript();
  if (ts && typeof ts.version === 'string') return ts.version;
  return '0.0.0';
}

function isTypeScriptPath(filePath) {
  return TS_EXTS.has(path.extname(String(filePath)).toLowerCase());
}

/**
 * Pre-transpile TypeScript or TSX sources to JavaScript that the
 * Esprima-based escomplex kernel can parse. Returns the input unchanged
 * for `.js` / `.mjs` / `.cjs` paths.
 *
 * Type annotations introduce no control flow, so the transpiled output
 * scores identically to the original TS for cyclomatic complexity,
 * Halstead volume, and the maintainability index. `.tsx` uses the
 * `react-jsx` emit so JSX expressions become function calls escomplex
 * can read; `.preserve` would leave JSX in the output and Esprima would
 * choke on it.
 *
 * On transpile failure the helper returns `null` — callers treat that
 * as "skip this file" rather than crashing the scan.
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {string|null}
 */
export function transpileIfNeeded(filePath, source) {
  if (!isTypeScriptPath(filePath)) return source;
  const ts = loadTypeScript();
  if (!ts) {
    Logger.warn(
      `[Maintainability] ⚠ typescript package not resolvable; cannot score ${filePath}. ` +
        "Install with 'npm install --save-dev typescript' (peer dep, >=5.0.0).",
    );
    return null;
  }
  try {
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
        noEmitHelpers: true,
        importHelpers: false,
        removeComments: false,
        jsx: ts.JsxEmit.ReactJSX,
        sourceMap: false,
      },
      fileName: path.basename(filePath),
      reportDiagnostics: false,
    });
    return result.outputText;
  } catch (err) {
    Logger.warn(
      `[Maintainability] ⚠ TS transpile failed for ${filePath}: ${err?.message ?? err}; skipping.`,
    );
    return null;
  }
}

/**
 * @returns {boolean} True when the path's extension is one the engines score.
 */
function isSupportedSourceFile(filePath) {
  return SUPPORTED_EXTS.has(path.extname(String(filePath)).toLowerCase());
}

/**
 * Loads the current maintainability baseline from disk. The on-disk path is
 * resolved by the caller via {@link getBaselines}; passing it explicitly
 * removes the silent-default behaviour the framework dropped in Epic #730
 * Story 5.5.
 *
 * @param {string} baselinePath  Repo-relative or absolute path to the baseline
 *   JSON. Required.
 * @returns {Record<string, number>}
 */
/**
 * Story #1895: project the canonical maintainability envelope back to the
 * legacy flat `{ path: mi }` map so existing gate consumers keep working
 * without churn — Story #1912 will replace this shim with the shared
 * reader. Returns the parsed input unchanged when it doesn't look like an
 * envelope (legacy flat shape stays flat).
 */
function projectMaintainabilityEnvelopeToFlat(parsed) {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.rows) ||
    typeof parsed.$schema !== 'string'
  ) {
    return parsed;
  }
  const flat = {};
  for (const row of parsed.rows) {
    if (row && typeof row.path === 'string' && typeof row.mi === 'number') {
      flat[row.path] = row.mi;
    }
  }
  return flat;
}

export function getBaseline(baselinePath) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new TypeError(
      'maintainability-utils.getBaseline: baselinePath is required (Epic #730 ' +
        'Story 5.5 — callers resolve the path via getBaselines(config).maintainability.path).',
    );
  }
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);
  if (!fs.existsSync(abs)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    return projectMaintainabilityEnvelopeToFlat(parsed);
  } catch (err) {
    Logger.warn(`[Maintainability] Failed to parse baseline: ${err.message}`);
    return {};
  }
}

/**
 * Saves a new maintainability baseline to disk at `baselinePath`.
 *
 * Accepts the legacy flat `{ path: mi }` shape for backwards compatibility
 * with existing callers (`regenerateMainFromTree`, refresh helpers). The
 * map is transformed into the canonical envelope shape (`$schema`,
 * `kernelVersion`, `generatedAt`, `rollup`, `rows`) via the shared
 * `lib/baselines/writer.js` pipeline before being persisted, so every
 * write produces a file that round-trips through `lib/baselines/reader.js`
 * without schema errors.
 *
 * @param {Record<string, number>} baseline  path→MI flat map.
 * @param {string} baselinePath  Required — caller supplies via getBaselines().
 */
export function saveBaseline(baseline, baselinePath) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new TypeError(
      'maintainability-utils.saveBaseline: baselinePath is required.',
    );
  }
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);

  const rows = Object.entries(baseline ?? {}).map(([p, mi]) => ({
    path: p,
    mi,
  }));
  const envelope = writeBaselineEnvelope({ kind: 'maintainability', rows });
  writeBaselineFile(abs, envelope);
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'temp',
  '.worktrees',
  'coverage',
  '.next',
]);

/**
 * Recursively scans a directory for JS/TS source files. Accepts `.js`,
 * `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts`. Directories listed
 * in `IGNORED_DIRS` (including `coverage` and `.next`, added in 5.29.0
 * to skip vitest's istanbul HTML scaffolding and Next.js build output)
 * are skipped.
 *
 * @param {string} dir
 * @param {string[]} fileList
 * @param {{ ignoreGlobs?: string[], cwd?: string }} [opts]
 *   `ignoreGlobs` — minimatch patterns matched against the canonicalised
 *   repo-relative path of each discovered file. Files whose path matches
 *   any pattern are excluded before scoring. Absent/empty is a no-op.
 *   `cwd` — root used to compute repo-relative paths for glob matching;
 *   defaults to `process.cwd()` when omitted.
 * @returns {string[]}
 */
export function scanDirectory(dir, fileList = [], opts = {}) {
  const { ignoreGlobs = [], cwd: optsCwd } = opts;
  const matchCwd = optsCwd ?? process.cwd();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return fileList;
    throw err;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        scanDirectory(filePath, fileList, opts);
      }
    } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
      if (ignoreGlobs.length > 0) {
        const absFilePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(filePath);
        const rawRel = path.relative(matchCwd, absFilePath).replace(/\\/g, '/');
        const relPath = canonicalisePath(rawRel);
        if (ignoreGlobs.some((g) => minimatch(relPath, g, { dot: true }))) {
          continue;
        }
      }
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Calculates maintainability scores for a list of file paths.
 *
 * Each file's transpile-then-analyze unit is dispatched to a
 * worker_threads pool sized to `os.availableParallelism()`. Workers
 * are recycled across files so TypeScript loads at most once per
 * worker. The pool is bypassed for batches of fewer than
 * `SERIAL_THRESHOLD` files because spawn overhead dominates at small
 * sizes — the in-process path matches the pre-pool serial behaviour
 * byte-for-byte.
 *
 * Output is sorted by relative file path so the returned object is
 * insertion-order-stable regardless of which worker happened to
 * finish first. Files that fail to read/transpile/parse are dropped
 * from the result (matching the pre-pool log-and-continue contract);
 * worker-side per-item failures surface as a `null` score that is
 * filtered out before assembly.
 *
 * @param {string[]} paths
 * @returns {Promise<Record<string, number>>}
 */
export async function calculateAll(paths) {
  const cwd = process.cwd();
  const indexed = paths.map((p) => ({
    abs: p,
    relPath: path.relative(cwd, p).replace(/\\/g, '/'),
  }));

  let perFile;
  if (indexed.length < SERIAL_THRESHOLD) {
    perFile = indexed.map(({ abs, relPath }) => {
      try {
        return { relPath, score: calculateForFile(abs) };
      } catch (err) {
        Logger.error(
          `[Maintainability] Failed to process ${abs}: ${err.message}`,
        );
        return { relPath, score: null };
      }
    });
  } else {
    const results = await runOnPool(
      MAINTAINABILITY_WORKER_URL,
      indexed.map((e) => e.abs),
    );
    perFile = results.map((r, i) => {
      const { abs, relPath } = indexed[i];
      if (!r || r.__cpuPoolError) {
        Logger.error(
          `[Maintainability] Worker pool error for ${abs}: ${r?.message ?? 'unknown'}`,
        );
        return { relPath, score: null };
      }
      if (r.score === null && r.error) {
        Logger.error(`[Maintainability] Failed to process ${abs}: ${r.error}`);
      }
      return { relPath, score: r.score };
    });
  }

  perFile.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );

  const scores = {};
  for (const { relPath, score } of perFile) {
    if (score === null) continue;
    scores[relPath] = score;
  }
  return scores;
}
