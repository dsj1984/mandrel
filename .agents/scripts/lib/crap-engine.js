import { coverageForMethodInEntry } from './coverage-utils.js';
import { resolveRawRow } from './crap-baseline-join.js';
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  crapFormula,
} from './crap-coordinates.js';
import { deriveMethodIdentities } from './crap-method-identity.js';
import { install as installAstCompat } from './escomplex-ast-compat.js';
import { analyzeModule } from './escomplex-kernel.js';

export { COORDINATE_ORIGINAL, COORDINATE_TRANSPILED, crapFormula };

/**
 * Returned for a source the kernel cannot parse — never `[]`, which would be
 * indistinguishable from a file with no methods.
 */
export const UNSCORABLE = null;

// Without the AST compat shim, modern syntax aborts `analyzeModule` for the
// whole file. Installed here, where the worker and serial scorers converge,
// so every entrypoint gets it by construction.
installAstCompat();

/**
 * No mapper: already original coordinates. An unresolved mapping stays
 * transpiled, and says so.
 *
 * @param {number} rawStartLine escomplex's `lineStart`.
 * @param {((line: number) => number|null)|null} mapLine
 * @returns {{startLine: number, coordinateSystem: 'original'|'transpiled'}}
 */
function resolveCoordinate(rawStartLine, mapLine) {
  if (typeof mapLine !== 'function') {
    return { startLine: rawStartLine, coordinateSystem: COORDINATE_ORIGINAL };
  }
  const mapped = mapLine(rawStartLine);
  return typeof mapped === 'number'
    ? { startLine: mapped, coordinateSystem: COORDINATE_ORIGINAL }
    : { startLine: rawStartLine, coordinateSystem: COORDINATE_TRANSPILED };
}

/**
 * Raw per-method CRAP rows, shared by the CRAP-only and combined MI paths.
 * A row still in transpiled coordinates joins no coverage: a transpiled line
 * can land inside an unrelated function's `fnMap` range and mis-attribute it.
 *
 * @param {object|null} report An `escomplex.analyzeModule` report.
 * @param {object|null} coverageForFile Istanbul coverage entry for this file.
 * @param {((line: number) => number|null)|null} [mapLine]
 * @returns {Array<{
 *   method: string,
 *   anonymous: boolean,
 *   startLine: number,
 *   cyclomatic: number,
 *   coverage: number|null,
 *   crap: number|null,
 *   coordinateSystem: 'original'|'transpiled',
 * }>}
 */
export function methodRowsFromReport(report, coverageForFile, mapLine = null) {
  const methods = report?.methods ?? [];
  // Derive identities over the whole list before skipping, so a skipped
  // method cannot shift its siblings' ordinals.
  const identities = deriveMethodIdentities(methods);
  const rows = [];
  for (const [i, m] of methods.entries()) {
    const rawStartLine = m?.lineStart;
    if (typeof rawStartLine !== 'number') continue;
    const { startLine, coordinateSystem } = resolveCoordinate(
      rawStartLine,
      mapLine,
    );
    const cyclomatic = m?.cyclomatic ?? 0;
    const coverage =
      coverageForFile && coordinateSystem === COORDINATE_ORIGINAL
        ? coverageForMethodInEntry(coverageForFile, startLine)
        : null;
    const crap = coverage === null ? null : crapFormula(cyclomatic, coverage);
    rows.push({
      ...identities[i],
      startLine,
      cyclomatic,
      coverage,
      crap,
      coordinateSystem,
    });
  }
  return rows;
}

/**
 * Apply `requireCoverage`: `true` skips an unresolved method; `false` scores
 * it 0% covered. With no coverage artifact at all (`coverageAvailable:
 * false`) or a transpiled (unjoinable) line, the method is skipped under
 * either policy — absent or unjoinable is not untested. The counters measure
 * the join, not the fill, for the resolution-rate floor.
 *
 * @param {Array<object>} rawRows Rows from `methodRowsFromReport`.
 * @param {{requireCoverage?: boolean, coverageAvailable?: boolean}} [opts]
 * @returns {{
 *   rows: Array<object>,
 *   skippedMethodsNoCoverage: number,
 *   resolvedMethods: number,
 *   totalMethods: number,
 * }}
 */
export function finalizeMethodRows(
  rawRows,
  { requireCoverage = true, coverageAvailable = true } = {},
) {
  const rows = [];
  let skippedMethodsNoCoverage = 0;
  let resolvedMethods = 0;
  let totalMethods = 0;
  for (const mr of rawRows ?? []) {
    totalMethods += 1;
    const resolution = resolveRawRow(mr, {
      requireCoverage,
      coverageAvailable,
    });
    if (resolution.resolved) resolvedMethods += 1;
    if (resolution.row === null) {
      skippedMethodsNoCoverage += 1;
      continue;
    }
    rows.push(resolution.row);
  }
  return { rows, skippedMethodsNoCoverage, resolvedMethods, totalMethods };
}

export { finalizeMethodRowsWithBaseline } from './crap-baseline-join.js';

/**
 * Pure CRAP scoring kernel (`c² · (1 − cov)³ + c`); never skips — unresolved
 * coverage yields `null` fields. Callers MUST branch on `rows === null`
 * ({@link UNSCORABLE}) before iterating.
 *
 * @param {string} source JavaScript source text (possibly transpiled).
 * @param {object|null} coverageForFile This file's `coverage-final.json` entry.
 * @param {((line: number) => number|null)|null} [mapLine] Transpiled →
 *   original line resolver.
 * @returns {Array<{
 *   method: string,
 *   anonymous: boolean,
 *   startLine: number,
 *   cyclomatic: number,
 *   coverage: number|null,
 *   crap: number|null,
 *   coordinateSystem: 'original'|'transpiled',
 * }>|null} The method rows, or {@link UNSCORABLE} when the source did not
 *   parse.
 */
export function calculateCrapForSource(
  source,
  coverageForFile,
  mapLine = null,
) {
  let report;
  try {
    report = analyzeModule(source);
  } catch {
    return UNSCORABLE;
  }
  return methodRowsFromReport(report, coverageForFile, mapLine);
}

/**
 * Single-axis fixes bringing a method under `target`: the complexity to reach
 * (`floor(sqrt(target))`), and the coverage needed at current complexity
 * (`1 − ((target − c) / c²)^(1/3)`; null when `c > target` or `c ≤ 0`).
 *
 * @param {{ cyclomatic: number, target: number }} params
 * @returns {{
 *   crapCeiling: number,
 *   minComplexityAt100Cov: number,
 *   minCoverageAtCurrentComplexity: number | null,
 * } | null}
 */
export function deriveFixGuidance({ cyclomatic, target } = {}) {
  const c = Number(cyclomatic);
  const t = Number(target);
  if (!Number.isFinite(c) || !Number.isFinite(t) || t < 0) return null;

  const minComplexityAt100Cov = Math.max(0, Math.floor(Math.sqrt(t)));

  let minCoverageAtCurrentComplexity = null;
  if (c > 0 && t >= c) {
    const ratio = (t - c) / (c * c);
    const minCov = 1 - Math.cbrt(ratio);
    minCoverageAtCurrentComplexity = Math.max(0, Math.min(1, minCov));
  }

  return {
    crapCeiling: t,
    minComplexityAt100Cov,
    minCoverageAtCurrentComplexity,
  };
}
