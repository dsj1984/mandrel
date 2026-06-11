import fs from 'node:fs';
import escomplex from 'typhonjs-escomplex';
import { transpileIfNeeded } from './transpile.js';

/**
 * Calculates the maintainability score of a JavaScript source file or string.
 * Uses `typhonjs-escomplex` internally, which provides a maintainability index
 * based on the Halstead Volume, Cyclomatic Complexity, and Lines of Code.
 */
/**
 * Calculate score for a raw string of source code.
 * @param {string} sourceCode The JavaScript source code.
 * @returns {number} Score between 0 and 171. Higher is better.
 */
export function calculateForSource(sourceCode) {
  try {
    const result = escomplex.analyzeModule(sourceCode);
    return result.maintainability;
  } catch (_err) {
    // Return 0 if the parser fails (e.g. invalid syntax)
    return 0;
  }
}

/**
 * Calculate score for a given file. TypeScript and TSX sources are
 * pre-transpiled in memory via `transpileIfNeeded` before being fed to
 * the JS-only escomplex kernel; the score for a TS file is identical to
 * the score the same logic would produce as plain JS, because TS type
 * annotations introduce no control flow.
 *
 * @param {string} filePath Path to the JS/TS source file.
 * @returns {number} Maintainability index, or 0 when the source cannot
 *   be parsed (escomplex parse error or TS transpile failure).
 */
export function calculateForFile(filePath) {
  try {
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const prepared = transpileIfNeeded(filePath, sourceCode);
    if (prepared === null) return 0;
    return calculateForSource(prepared);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }
}

/**
 * Produce a richer maintainability report that includes per-method scores.
 *
 * The module-level index from escomplex is heavily penalised by Halstead
 * volume, which means well-structured but long files (many small helpers)
 * score as "critical" even when no single function is complex. Consumers
 * that need to tier findings by real complexity should use `worstMethod`
 * (the lowest per-method maintainability) and fall back to `moduleScore`
 * for files that contain no methods (scripts that are purely top-level
 * statements).
 *
 * @param {string} sourceCode
 * @returns {{
 *   moduleScore: number,
 *   methods: Array<{ name: string, maintainability: number, cyclomatic: number, sloc: number|null }>,
 *   worstMethod: number|null,
 *   meanMethod: number|null,
 *   parseError: boolean,
 * }}
 */
export function calculateReport(sourceCode) {
  try {
    const result = escomplex.analyzeModule(sourceCode);
    const methods = (result.methods ?? []).map((m) => ({
      name: m.name,
      maintainability:
        typeof m.maintainability === 'number'
          ? m.maintainability
          : (result.maintainability ?? 0),
      cyclomatic: m.cyclomatic ?? 0,
      sloc: m.sloc?.logical ?? null,
    }));
    const scores = methods.map((m) => m.maintainability);
    const worstMethod = scores.length > 0 ? Math.min(...scores) : null;
    const meanMethod =
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : null;
    return {
      moduleScore: result.maintainability,
      methods,
      worstMethod,
      meanMethod,
      parseError: false,
    };
  } catch (_err) {
    return {
      moduleScore: 0,
      methods: [],
      worstMethod: null,
      meanMethod: null,
      parseError: true,
    };
  }
}

/**
 * Convenience wrapper that reads a file from disk and produces a report.
 * TypeScript and TSX sources are transpiled in memory before scoring.
 *
 * @param {string} filePath
 * @returns {ReturnType<typeof calculateReport>}
 */
export function calculateReportForFile(filePath) {
  try {
    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const prepared = transpileIfNeeded(filePath, sourceCode);
    if (prepared === null) {
      return {
        moduleScore: 0,
        methods: [],
        worstMethod: null,
        meanMethod: null,
        parseError: true,
      };
    }
    return calculateReport(prepared);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }
}

/**
 * Classify a maintainability report into a severity tier.
 *
 * Tiering rules (chosen after the v5.11 calibration issue where clean
 * multi-hundred-line scripts scored 0 at the module level):
 *
 *   - 🔴 critical  — a real hotspot: some method scores < 20, OR the file
 *                    contains no methods and the module scores < 40.
 *   - 🟡 warning   — size- or volume-driven signal: worst method < 50
 *                    OR module score < 65 (but no critical method).
 *   - 🟢 healthy   — every method scores ≥ 50 and module ≥ 65.
 *
 * File-size-driven module-score drops land in the warning tier, not the
 * critical tier — they should nudge the reviewer, not block the sprint.
 *
 * @param {ReturnType<typeof calculateReport>} report
 * @returns {'critical' | 'warning' | 'healthy' | 'parse-error'}
 */
export function classifyReport(report) {
  if (!report || report.parseError) return 'parse-error';
  const { moduleScore, worstMethod, methods } = report;

  if (worstMethod !== null && worstMethod < 20) return 'critical';
  if (methods.length === 0 && moduleScore < 40) return 'critical';

  if (worstMethod !== null && worstMethod < 50) return 'warning';
  if (moduleScore < 65) return 'warning';

  return 'healthy';
}
