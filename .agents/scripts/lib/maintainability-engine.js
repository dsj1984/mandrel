import fs from 'node:fs';
import { install as installAstCompat } from './escomplex-ast-compat.js';
import { analyzeModule } from './escomplex-kernel.js';
import { transpileIfNeeded } from './transpile.js';

/**
 * Calculates the maintainability score of a JavaScript source file or string.
 * Uses `typhonjs-escomplex` internally, which provides a maintainability index
 * based on the Halstead Volume, Cyclomatic Complexity, and Lines of Code.
 *
 * The kernel's code generator predates the Babel AST its own parser emits, so
 * ordinary modern syntax (`?.`, `await` in a loop head, a regex in a loop
 * head, object spread in a default parameter) aborts the whole analysis.
 * `escomplex-ast-compat` repairs that before any scoring runs — see that
 * module for the defect and the upstream status.
 */
installAstCompat();

/**
 * Sentinel score for a file the kernel cannot analyse.
 *
 * A real maintainability index never reaches 0 for runnable code — the
 * escomplex floor is ~10–20 — so 0 has long been used as an out-of-band
 * "unscorable" marker. That overload is the bug: consumers drop `mi === 0`
 * rows, so an unscorable file silently vanishes from the baseline instead of
 * being reported, and no amount of re-seeding can ever give it a row.
 *
 * Deliberately module-private. The numeric return is kept for backwards
 * compatibility, but the *value* is not something a caller should branch on —
 * that is the overload this change exists to stop propagating. Callers that
 * need to tell "unscorable" from "genuinely terrible" read the `unscorable`
 * flag from {@link scoreSource} / {@link scoreFile}.
 */
const UNSCORABLE = 0;

/**
 * Score a raw string, distinguishing "the kernel could not analyse this" from
 * "this scored badly".
 *
 * @param {string} sourceCode The JavaScript source code.
 * @returns {{ score: number, unscorable: boolean, reason: string|null }}
 *   `score` is {@link UNSCORABLE} when `unscorable` is true; `reason` carries
 *   the kernel's own error message so a consumer can report *why* rather than
 *   just omitting the file.
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
 * Calculate score for a raw string of source code.
 *
 * Returns 0 for unscorable input, which is ambiguous by construction — see
 * {@link UNSCORABLE}. Prefer {@link scoreSource} in new code.
 *
 * @param {string} sourceCode The JavaScript source code.
 * @returns {number} Score between 0 and 171. Higher is better.
 */
export function calculateForSource(sourceCode) {
  return scoreSource(sourceCode).score;
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
  return scoreFile(filePath).score;
}

/**
 * Score a file, distinguishing "unscorable" from "scored badly".
 *
 * The transpile-failure and kernel-failure cases are reported separately
 * because they need different fixes: a transpile failure is usually the
 * consumer's own syntax or `tsconfig`, whereas a kernel failure is the
 * upstream generator gap described in `escomplex-ast-compat.js`.
 *
 * @param {string} filePath Path to the JS/TS source file.
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
