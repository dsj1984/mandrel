import fs from 'node:fs';
import { install as installAstCompat } from './escomplex-ast-compat.js';
import { analyzeModule } from './escomplex-kernel.js';
import { transpileIfNeeded } from './transpile.js';

installAstCompat();

/** Branch on the `unscorable` flag, never on this value. */
const UNSCORABLE = 0;

/**
 * @param {string} sourceCode
 * @returns {{ score: number, unscorable: boolean, reason: string|null }}
 */
export function scoreSource(sourceCode) {
  try {
    const score = analyzeModule(sourceCode)?.maintainability;
    return Number.isFinite(score)
      ? { score, unscorable: false, reason: null }
      : unscorable(`kernel returned a non-finite index (${String(score)})`);
  } catch (err) {
    return unscorable(
      `${err?.constructor?.name ?? 'Error'}: ${err?.message ?? 'unknown kernel failure'}`,
    );
  }
}

/**
 * @param {string} reason
 * @returns {{ score: number, unscorable: boolean, reason: string }}
 */
function unscorable(reason) {
  return { score: UNSCORABLE, unscorable: true, reason };
}

/**
 * Ambiguous 0 when unscorable — prefer {@link scoreSource}.
 *
 * @param {string} sourceCode
 * @returns {number}
 */
export function calculateForSource(sourceCode) {
  return scoreSource(sourceCode).score;
}

/**
 * @param {string} filePath
 * @returns {number}
 */
export function calculateForFile(filePath) {
  return scoreFile(filePath).score;
}

/**
 * TS is transpiled first. Transpile and kernel failures need different
 * fixes, so they are reported separately.
 *
 * @param {string} filePath
 * @returns {{ score: number, unscorable: boolean, reason: string|null }}
 */
export function scoreFile(filePath) {
  let sourceCode;
  try {
    sourceCode = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }

  const prepared = transpileIfNeeded(filePath, sourceCode);
  if (prepared === null) return unscorable('TypeScript transpile failed');
  return scoreSource(prepared);
}

/**
 * The module index is Halstead-volume dominated, so tier by `worstMethod`.
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
    const result = analyzeModule(sourceCode);
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
 * Size-driven module drops only reach `warning`; `critical` is a real hotspot.
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
