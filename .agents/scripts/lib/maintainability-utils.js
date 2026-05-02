import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { calculateForFile } from './maintainability-engine.js';

const require = createRequire(import.meta.url);

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
    console.warn(
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
    console.warn(
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
  if (fs.existsSync(abs)) {
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf-8'));
    } catch (err) {
      console.warn(
        `[Maintainability] Failed to parse baseline: ${err.message}`,
      );
      return {};
    }
  }
  return {};
}

/**
 * Saves a new maintainability baseline to disk at `baselinePath`.
 * @param {Record<string, number>} baseline
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
  // Sort keys for deterministic output
  const sortedBaseline = Object.keys(baseline)
    .sort()
    .reduce((acc, key) => {
      acc[key] = baseline[key];
      return acc;
    }, {});

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(sortedBaseline, null, 2)}\n`);
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
 * @param {string} dir
 * @param {string[]} fileList
 * @returns {string[]}
 */
export function scanDirectory(dir, fileList = []) {
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
        scanDirectory(filePath, fileList);
      }
    } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Calculates maintainability scores for a list of file paths.
 * @param {string[]} paths
 * @returns {Record<string, number>}
 */
export function calculateAll(paths) {
  const scores = {};
  paths.forEach((p) => {
    // Use relative paths for the baseline to ensure portability
    const relativePath = path.relative(process.cwd(), p).replace(/\\/g, '/');
    try {
      scores[relativePath] = calculateForFile(p);
    } catch (err) {
      console.error(`[Maintainability] Failed to process ${p}: ${err.message}`);
    }
  });
  return scores;
}
