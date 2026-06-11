import { createRequire } from 'node:module';
import path from 'node:path';
import { Logger } from './Logger.js';

const require = createRequire(import.meta.url);

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

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
