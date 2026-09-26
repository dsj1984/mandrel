import fs from 'node:fs';
import { createRequire, SourceMap } from 'node:module';
import path from 'node:path';
import { resolveDependencyVersion } from './dependency-version.js';
import { Logger } from './Logger.js';

const require = createRequire(import.meta.url);

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * The `typescript` majors whose main entry exposes the JS compiler API. TS 7
 * moved `transpileModule` under `unstable/*`, so its main entry is API-less.
 * Mirrors the optional peer range in `package.json` / `runtime-deps.json`.
 */
const SUPPORTED_TS_RANGE = '>=5.0.0 <7';

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

/** Compiler modules already diagnosed as API-less — one warning per module. */
const _unsupportedDiagnosed = new WeakSet();

/**
 * A resolved module without `transpileModule` cannot score anything; say so
 * once, naming the version and the supported range, instead of one
 * "transpile failed" warning per file.
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

let _tsVersion = null;

/**
 * `typescript` version for baseline stamps, read from the manifest (never by
 * loading the compiler). `'0.0.0'` means unknown environment.
 *
 * @returns {string}
 */
export function resolveTsTranspilerVersion() {
  if (_tsVersion === null) {
    _tsVersion = resolveDependencyVersion('typescript', require) ?? '0.0.0';
  }
  return _tsVersion;
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
 * through; `null` means skip. Transpiling shifts lines, so a coverage join
 * opts into `{ withLineMap: true }` → `{ code, mapLine }` (`null` for JS).
 *
 * `opts.typescript` substitutes the compiler module (defaults to the resolved
 * `typescript` peer).
 *
 * @param {string} filePath
 * @param {string} source
 * @param {{withLineMap?: boolean, typescript?: object}} [opts]
 * @returns {string|null|{code: string, mapLine: ((line: number) => number|null)|null}}
 */
export function transpileIfNeeded(filePath, source, opts = {}) {
  const withLineMap = opts?.withLineMap === true;
  if (!isTypeScriptPath(filePath)) {
    return withLineMap ? { code: source, mapLine: null } : source;
  }
  const ts = opts?.typescript ?? loadTypeScript();
  if (!ts) {
    Logger.warn(
      `[Maintainability] ⚠ typescript package not resolvable; cannot score ${filePath}. ` +
        `Install with 'npm install --save-dev typescript' (peer dep, ${SUPPORTED_TS_RANGE}).`,
    );
    return null;
  }
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
 * Read + transpile with a line map. Read and transpile failures stay
 * distinct: the MI path drops the score on `read` but scores 0 on `transpile`.
 *
 * @param {string} abs
 * @param {{readFile?: (p: string) => string, transpile?: Function}} [deps]
 * @returns {{code: string, mapLine: ((line: number) => number|null)|null}
 *   | {error: 'read'|'transpile'}}
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
  if (prepared === null || prepared === undefined)
    return { error: 'transpile' };
  // Tolerate a `deps.transpile` stub that still returns a bare string.
  if (typeof prepared === 'string') return { code: prepared, mapLine: null };
  if (typeof prepared.code !== 'string') return { error: 'transpile' };
  return { code: prepared.code, mapLine: prepared.mapLine ?? null };
}
