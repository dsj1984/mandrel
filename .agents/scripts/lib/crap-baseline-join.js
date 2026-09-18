/**
 * The incremental-coverage CRAP join. Imports primitives from
 * `crap-coordinates.js`, never `crap-engine.js`, which imports from here.
 */
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  crapFormula,
} from './crap-coordinates.js';

/**
 * Per-file half of `crapRowKey` (`${path}::${method}@${startLine}`).
 *
 * @param {{method: string, startLine: number}} row
 * @returns {string}
 */
function methodIdentityKey(row) {
  return `${row.method}@${row.startLine}`;
}

/**
 * Accepts both the in-memory `{file}` and on-disk `{path}` row shapes.
 *
 * @param {Array<{file?: string, path?: string, method: string, startLine: number, crap: number}>} baselineRows
 * @returns {Map<string, Map<string, {crap: number}>>} file → (method@startLine → row)
 */
function indexBaselineRowsByFile(baselineRows) {
  const byFile = new Map();
  for (const row of baselineRows ?? []) {
    const file = row?.file ?? row?.path;
    if (typeof file !== 'string' || file.length === 0) continue;
    if (!byFile.has(file)) byFile.set(file, new Map());
    byFile.get(file).set(methodIdentityKey(row), row);
  }
  return byFile;
}

/**
 * Both fields `null` means "not incremental".
 *
 * @param {{ touchedFiles?: Set<string>|string[], baselineRows?: Array<object> } | null} incremental
 * @returns {{ touchedFiles: Set<string>|null, baselineByFile: Map<string, Map<string, object>>|null }}
 */
export function resolveIncrementalContext(incremental) {
  const touchedFiles = incremental?.touchedFiles
    ? incremental.touchedFiles instanceof Set
      ? incremental.touchedFiles
      : new Set(incremental.touchedFiles)
    : null;
  const baselineByFile = incremental
    ? indexBaselineRowsByFile(incremental.baselineRows)
    : null;
  return { touchedFiles, baselineByFile };
}

/**
 * Outside incremental mode every file is `touched`.
 *
 * @param {object} item Base queue item (`{ abs, relPath, requireCoverage, coverageAvailable }`).
 * @param {{ touchedFiles: Set<string>|null, baselineByFile: Map<string, Map<string, object>>|null }} ctx
 * @returns {object} `item` plus `{ touched, baselineByKey }`.
 */
export function resolveQueueIncrementalFields(
  item,
  { touchedFiles, baselineByFile },
) {
  const touched = touchedFiles ? touchedFiles.has(item.relPath) : true;
  const baselineByKey = baselineByFile
    ? (baselineByFile.get(item.relPath) ?? new Map())
    : null;
  return { ...item, touched, baselineByKey };
}

/**
 * @param {boolean} touched
 * @param {Map<string, object>|null} baselineByKey
 * @returns {boolean}
 */
function isIncrementalJoinActive(touched, baselineByKey) {
  return !touched && baselineByKey != null && baselineByKey.size > 0;
}

/**
 * @param {boolean} requireCoverage
 * @param {object|null} entry Istanbul coverage entry for this file.
 * @param {boolean} touched
 * @param {Map<string, object>|null} baselineByKey
 * @returns {boolean}
 */
export function shouldSkipFileForNoCoverage(
  requireCoverage,
  entry,
  touched,
  baselineByKey,
) {
  return (
    requireCoverage &&
    entry === null &&
    !isIncrementalJoinActive(touched, baselineByKey)
  );
}

/**
 * The per-row `requireCoverage` policy, shared by both finalize paths.
 *
 * @param {object} mr A raw row from `methodRowsFromReport`.
 * @param {{requireCoverage: boolean, coverageAvailable: boolean}} opts
 * @returns {{ resolved: boolean, row: object | null }} `row: null` means
 *   skipped-and-counted; `resolved` tracks the join alone.
 */
export function resolveRawRow(mr, { requireCoverage, coverageAvailable }) {
  const unresolved = mr.crap === null || mr.coverage === null;
  const resolved = !unresolved;
  // Unjoinable (transpiled) is not untested.
  if (
    mr.coordinateSystem === COORDINATE_TRANSPILED ||
    (unresolved && (requireCoverage || !coverageAvailable))
  ) {
    return { resolved, row: null };
  }
  const coverage = unresolved ? 0 : mr.coverage;
  const crap = unresolved ? crapFormula(mr.cyclomatic, 0) : mr.crap;
  // Spread, never rebuild: a hand-listed row silently drops markers.
  return {
    resolved,
    row: {
      ...mr,
      coverage,
      crap,
      coordinateSystem: mr.coordinateSystem ?? COORDINATE_ORIGINAL,
    },
  };
}

/**
 * For a file the diff did not touch, resolve methods from committed baseline
 * rows: a skipped capture leaves its coverage entry legitimately absent, and
 * neither skip-and-count nor an invented 0% would be a measurement. Touched
 * files, an empty baseline, a missing row or a transpiled line all fall back
 * to `resolveRawRow` — never an invented verdict.
 *
 * @param {Array<object>} rawRows Rows from `methodRowsFromReport`, all for
 *   the SAME file.
 * @param {{
 *   requireCoverage?: boolean,
 *   coverageAvailable?: boolean,
 *   touched?: boolean,
 *   baselineByKey?: Map<string, {crap: number}> | null,
 * }} [opts]
 * @returns {{
 *   rows: Array<object>,
 *   skippedMethodsNoCoverage: number,
 *   resolvedMethods: number,
 *   totalMethods: number,
 * }}
 */
export function finalizeMethodRowsWithBaseline(
  rawRows,
  {
    requireCoverage = true,
    coverageAvailable = true,
    touched = true,
    baselineByKey = null,
  } = {},
) {
  const useBaseline = !touched && baselineByKey && baselineByKey.size > 0;
  const rows = [];
  let skippedMethodsNoCoverage = 0;
  let resolvedMethods = 0;
  let totalMethods = 0;
  for (const mr of rawRows ?? []) {
    totalMethods += 1;
    if (useBaseline) {
      const base =
        mr.coordinateSystem === COORDINATE_TRANSPILED
          ? undefined
          : baselineByKey.get(methodIdentityKey(mr));
      if (base && typeof base.crap === 'number') {
        resolvedMethods += 1;
        rows.push({
          ...mr,
          coverage: null,
          crap: base.crap,
          resolvedFromBaseline: true,
          coordinateSystem: mr.coordinateSystem ?? COORDINATE_ORIGINAL,
        });
        continue;
      }
    }
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
