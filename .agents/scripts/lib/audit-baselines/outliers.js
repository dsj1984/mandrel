/**
 * Bounded top-N outliers per gate, so no whole baseline enters the envelope.
 * Rows fold to the file grain (worst value kept), then `severityWeight` is
 * the position in the kind's own distribution (0 best … 1 worst) — which is
 * what makes unit-less axes like CRAP and MI summable in a cluster.
 *
 * @module lib/audit-baselines/outliers
 */

import { KIND_SPECS } from './kinds.js';

export const DEFAULT_TOP_N = 20;

/**
 * One entry per id, worst value kept.
 *
 * @param {Array<{ id: string, value: number }>} rows
 * @param {'higher' | 'lower'} worse
 * @returns {Array<{ id: string, value: number, rowCount: number }>}
 */
function aggregateById(rows, worse) {
  const byId = new Map();
  for (const { id, value } of rows) {
    const prev = byId.get(id);
    if (prev === undefined) {
      byId.set(id, { id, value, rowCount: 1 });
      continue;
    }
    prev.rowCount += 1;
    const isWorse =
      worse === 'higher' ? value > prev.value : value < prev.value;
    if (isWorse) prev.value = value;
  }
  return [...byId.values()];
}

/**
 * 1 is always the worst end; a degenerate distribution scores all 1.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {'higher' | 'lower'} worse
 * @returns {number} 0..1
 */
function normalizeSeverity(value, min, max, worse) {
  if (!(max > min)) return 1;
  const ratio = (value - min) / (max - min);
  return worse === 'higher' ? ratio : 1 - ratio;
}

/**
 * @param {{ kind: string, baseline: object | null, topN?: number }} args
 * @returns {Array<{
 *   kind: string, id: string, metric: string, value: number,
 *   rowCount: number, severityWeight: number,
 * }>} worst first
 */
export function extractOutliers({ kind, baseline, topN = DEFAULT_TOP_N }) {
  const spec = KIND_SPECS[kind];
  if (!spec || !baseline) return [];
  const aggregated = aggregateById(spec.rows(baseline), spec.worse);
  if (aggregated.length === 0) return [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of aggregated) {
    if (row.value < min) min = row.value;
    if (row.value > max) max = row.value;
  }
  return aggregated
    .map((row) => ({
      kind,
      id: row.id,
      metric: spec.metric,
      value: row.value,
      rowCount: row.rowCount,
      severityWeight: normalizeSeverity(row.value, min, max, spec.worse),
    }))
    .sort(
      (a, b) => b.severityWeight - a.severityWeight || a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(0, topN));
}
