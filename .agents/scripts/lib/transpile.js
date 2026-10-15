import fs from 'node:fs';
import { createRequire, SourceMap } from 'node:module';
import path from 'node:path';
import { resolveDependencyVersion } from './dependency-version.js';
import { Logger } from './Logger.js';

const moduleRequire = createRequire(import.meta.url);

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** TS 7 moved `transpileModule` under `unstable/*`; mirrors the peer range. */
const SUPPORTED_TS_RANGE = '>=5.0.0 <7';

/** No compiler resolved — distinct from `null`, a transpile failure. */
const COMPILER_MISSING = Object.freeze({ compilerMissing: true });

const DIAGNOSTIC_DIR_CAP = 10;

const MODULE_ANCHOR = '\0module-location';

// Misses are cached per anchor, never process-wide.
const _entryByAnchor = new Map();
const _compilerByEntry = new Map();
const _packageDirByDir = new Map();

/** Node's upward `node_modules` walk starts at `dir`. */
function requireFromDir(dir) {
  return createRequire(path.join(dir, 'noop.cjs'));
}

function requireForAnchor(anchor) {
  return anchor === MODULE_ANCHOR ? moduleRequire : requireFromDir(anchor);
}

function resolveEntry(anchor) {
  if (_entryByAnchor.has(anchor)) return _entryByAnchor.get(anchor);
  let entry = null;
  try {
    entry = requireForAnchor(anchor).resolve('typescript');
  } catch {
    entry = null;
  }
  _entryByAnchor.set(anchor, entry);
  return entry;
}

/** One load per installation. */
function loadCompiler(entry) {
  if (_compilerByEntry.has(entry)) return _compilerByEntry.get(entry);
  let ts = null;
  try {
    ts = moduleRequire(entry);
  } catch {
    ts = null;
  }
  _compilerByEntry.set(entry, ts);
  return ts;
}

/**
 * The file's own directory first: the walk finds its package's compiler and
 * passes the project root on the way. Then this module's location.
 */
function loadTypeScriptFor(filePath) {
  const anchors = [path.dirname(path.resolve(String(filePath))), MODULE_ANCHOR];
  for (const anchor of anchors) {
    const entry = resolveEntry(anchor);
    const ts = entry ? loadCompiler(entry) : null;
    if (ts) return ts;
  }
  return null;
}

/**
 * Nearest ancestor holding a `package.json` (else the file's directory).
 *
 * @param {string} filePath
 * @returns {string}
 */
export function owningPackageDir(filePath) {
  const start = path.dirname(path.resolve(String(filePath)));
  if (_packageDirByDir.has(start)) return _packageDirByDir.get(start);
  let dir = start;
  let found = start;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _packageDirByDir.set(start, found);
  return found;
}

function compilerMissingMessage(packageDirs, opts = {}) {
  const dirs = [...new Set(packageDirs)].sort();
  const render = (dir) =>
    opts.cwd ? path.relative(opts.cwd, dir).replace(/\\/g, '/') || '.' : dir;
  const shown = dirs.slice(0, DIAGNOSTIC_DIR_CAP).map(render);
  const more =
    dirs.length > shown.length ? ` (+${dirs.length - shown.length} more)` : '';
  return (
    `typescript is not resolvable for TypeScript sources in ${dirs.length} ` +
    `package(s): ${shown.join(', ')}${more}. Install it as a devDependency of ` +
    `each package ('npm install --save-dev typescript' there; supported ` +
    `range ${SUPPORTED_TS_RANGE}). No baseline was written.`
  );
}

/** The scorers throw this so update/check fail loud and write nothing. */
export class CompilerMissingError extends Error {
  constructor(packageDirs, opts = {}) {
    super(compilerMissingMessage(packageDirs, opts));
    this.name = 'CompilerMissingError';
    this.packageDirs = [...new Set(packageDirs)].sort();
    // An install step, not a crash: no trace.
    this.stack = `${this.name}: ${this.message}`;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCompilerMissing(value) {
  return value === COMPILER_MISSING;
}

/**
 * Scan-result fields for a failed prepare; only a missing compiler has any.
 *
 * @param {{error?: string, packageDir?: string}} prepared
 * @returns {{compilerMissing?: true, packageDir?: string}}
 */
export function preparedFailureFields(prepared) {
  if (prepared?.error !== 'compiler-missing') return {};
  return { compilerMissing: true, packageDir: prepared.packageDir };
}

/** Compiler modules already diagnosed as API-less — one warning per module. */
const _unsupportedDiagnosed = new WeakSet();

/**
 * Warn once per API-less module rather than once per file.
 *
 * @param {object} ts
 * @returns {boolean}
 */
function isUsableCompiler(ts) {
  if (typeof ts.transpileModule === 'function') return true;
  if (!_unsupportedDiagnosed.has(ts)) {
    _unsupportedDiagnosed.add(ts);
    Logger.warn(
      `[Maintainability] ⚠ typescript ${ts.version ?? 'unknown'} exposes no transpileModule API; ` +
        `TypeScript files are not scored. Supported range: ${SUPPORTED_TS_RANGE}.`,
    );
  }
  return false;
}

const _tsVersionByAnchors = new Map();

/**
 * `typescript` version stamp from manifests (never loading the compiler):
 * target dirs and project root, else this module's location. Distinct
 * versions are `+`-joined; `'0.0.0'` means unknown.
 *
 * @param {{ cwd?: string, targetDirs?: string[] }} [ctx]
 * @returns {string}
 */
export function resolveTsTranspilerVersion(ctx = {}) {
  const anchors = stampAnchors(ctx ?? {});
  const key = anchors.join('\n');
  if (!_tsVersionByAnchors.has(key)) {
    _tsVersionByAnchors.set(key, stampFrom(anchors));
  }
  return _tsVersionByAnchors.get(key);
}

function stampAnchors({ cwd, targetDirs }) {
  const dirs = Array.isArray(targetDirs) ? targetDirs.filter(Boolean) : [];
  if (!cwd) return dirs.filter((dir) => path.isAbsolute(dir));
  return [...dirs.map((dir) => path.resolve(cwd, dir)), path.resolve(cwd)];
}

function stampFrom(anchors) {
  const manifestVersion = (requireFn) =>
    resolveDependencyVersion('typescript', requireFn);
  let versions = anchors
    .map((anchor) => manifestVersion(requireFromDir(anchor)))
    .filter(Boolean);
  if (versions.length === 0) {
    versions = [manifestVersion(moduleRequire)].filter(Boolean);
  }
  if (versions.length === 0) return '0.0.0';
  return [...new Set(versions)].sort().join('+');
}

function isTypeScriptPath(filePath) {
  return TS_EXTS.has(path.extname(String(filePath)).toLowerCase());
}

/**
 * Stripped so a `sourceMap: true` emit is byte-identical to the plain one,
 * keeping MI scores unaffected by the CRAP path's map.
 */
const SOURCE_MAPPING_URL_RE = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/;

/**
 * Memoised `transpiledLine → originalLine` resolver. `findEntry` returns the
 * mapping at or *before* a position, so columns are walked and only an entry
 * on the same generated line is accepted; an unmapped line yields `null`.
 *
 * @param {string} sourceMapText
 * @param {string} code
 * @returns {((line: number) => number|null)|null}
 */
function buildLineMapper(sourceMapText, code) {
  let sourceMap;
  try {
    sourceMap = new SourceMap(JSON.parse(sourceMapText));
  } catch {
    return null;
  }
  const lines = String(code).split('\n');
  const memo = new Map();
  return function mapLine(generatedLine) {
    if (typeof generatedLine !== 'number' || generatedLine < 1) return null;
    if (memo.has(generatedLine)) return memo.get(generatedLine);
    const zeroBased = generatedLine - 1;
    const lineText = lines[zeroBased] ?? '';
    let resolved = null;
    for (let column = 0; column <= lineText.length; column += 1) {
      let entry;
      try {
        entry = sourceMap.findEntry(zeroBased, column);
      } catch {
        break;
      }
      if (
        entry &&
        entry.generatedLine === zeroBased &&
        typeof entry.originalLine === 'number'
      ) {
        resolved = entry.originalLine + 1;
        break;
      }
    }
    memo.set(generatedLine, resolved);
    return resolved;
  };
}

/**
 * TS/TSX → JS escomplex can parse (types add no control flow); JS passes
 * through; `null` means skip, `COMPILER_MISSING` no compiler. Transpiling
 * shifts lines, so a coverage join opts into `{ withLineMap: true }` →
 * `{ code, mapLine }` (`null` for JS).
 *
 * @param {string} filePath
 * @param {string} source
 * @param {{withLineMap?: boolean, typescript?: object}} [opts]
 * @returns {string|null|typeof COMPILER_MISSING|{code: string, mapLine: ((line: number) => number|null)|null}}
 */
export function transpileIfNeeded(filePath, source, opts = {}) {
  const withLineMap = opts?.withLineMap === true;
  if (!isTypeScriptPath(filePath)) {
    return withLineMap ? { code: source, mapLine: null } : source;
  }
  const ts = opts?.typescript ?? loadTypeScriptFor(filePath);
  if (!ts) return COMPILER_MISSING;
  if (!isUsableCompiler(ts)) return null;
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
        sourceMap: withLineMap,
      },
      fileName: path.basename(filePath),
      reportDiagnostics: false,
    });
    if (!withLineMap) return result.outputText;
    const code = result.outputText.replace(SOURCE_MAPPING_URL_RE, '\n');
    const mapLine =
      typeof result.sourceMapText === 'string'
        ? buildLineMapper(result.sourceMapText, code)
        : null;
    return { code, mapLine };
  } catch (err) {
    Logger.warn(
      `[Maintainability] ⚠ TS transpile failed for ${filePath}: ${err?.message ?? err}; skipping.`,
    );
    return null;
  }
}

/**
 * Read + transpile with a line map. Read, transpile and missing-compiler
 * failures stay distinct.
 *
 * @param {string} abs
 * @param {{readFile?: (p: string) => string, transpile?: Function}} [deps]
 * @returns {{code: string, mapLine: ((line: number) => number|null)|null}
 *   | {error: 'read'|'transpile'}
 *   | {error: 'compiler-missing', packageDir: string}}
 */
export function prepareSourceForScoring(abs, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const transpile = deps.transpile ?? transpileIfNeeded;
  let source;
  try {
    source = readFile(abs);
  } catch {
    return { error: 'read' };
  }
  const prepared = transpile(abs, source, { withLineMap: true });
  if (isCompilerMissing(prepared)) {
    return { error: 'compiler-missing', packageDir: owningPackageDir(abs) };
  }
  if (prepared === null || prepared === undefined)
    return { error: 'transpile' };
  // Tolerate a `deps.transpile` stub that still returns a bare string.
  if (typeof prepared === 'string') return { code: prepared, mapLine: null };
  if (typeof prepared.code !== 'string') return { error: 'transpile' };
  return { code: prepared.code, mapLine: prepared.mapLine ?? null };
}
