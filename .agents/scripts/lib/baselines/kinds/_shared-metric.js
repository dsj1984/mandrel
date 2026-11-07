/** Pure metric factories shared by the per-kind baseline modules. */

import { componentMatches } from '../component-matcher.js';

/**
 * Nearest-rank percentile over a pre-sorted ascending array.
 *
 * @param {number[]} sortedValues
 * @param {number} p - percentile in [0, 100]
 * @returns {number}
 */
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return sortedValues[idx];
}

/**
 * Empty rows yield 0 for every percentile and extras key.
 *
 * @param {{
 *   fields: Array<{
 *     name: string,
 *     rowKey: string,
 *     percentiles?: number[],
 *     extras?: (sorted: number[]) => Record<string, number>
 *   }>
 * }} opts
 * @returns {(rows: object[]) => Record<string, number>}
 */
export function makeAggregate({ fields }) {
  return function aggregate(rows) {
    if (!rows || rows.length === 0) {
      const zero = {};
      for (const f of fields) {
        for (const p of f.percentiles ?? []) {
          const key = p === 50 ? 'p50' : p === 95 ? 'p95' : `p${p}`;
          zero[key] = 0;
        }
        if (f.extras) {
          const sample = f.extras([]);
          for (const k of Object.keys(sample)) zero[k] = 0;
        }
        if (f.name && !(f.name in zero)) zero[f.name] = 0;
      }
      return zero;
    }

    const out = {};
    for (const f of fields) {
      const sorted = [...rows].map((r) => r[f.rowKey]).sort((a, b) => a - b);
      for (const p of f.percentiles ?? []) {
        const key = p === 50 ? 'p50' : p === 95 ? 'p95' : `p${p}`;
        out[key] = percentile(sorted, p);
      }
      if (f.extras) {
        Object.assign(out, f.extras(sorted));
      }
    }
    return out;
  };
}

/**
 * @param {{ aggregate: (rows: object[]) => Record<string, number> }} opts
 * @returns {(rows: object[], components?: object[]) => Record<string, object>}
 */
export function makeRollup({ aggregate }) {
  return function rollup(rows, components = []) {
    const out = { '*': aggregate(rows) };
    for (const c of components ?? []) {
      const matched = (rows ?? []).filter((r) => componentMatches(c, r.path));
      out[c.name] = aggregate(matched);
    }
    return out;
  };
}

/**
 * Within epsilon, the prior row object is returned so its bytes are kept.
 *
 * @param {{
 *   identity: (row: object) => string,
 *   metricField: string
 * }} opts
 * @returns {(prior: object[], regenerated: object[], epsilon: number) => object[]}
 */
export function makeEpsilon({ identity, metricField }) {
  return function applyEpsilon(prior, regenerated, epsilon) {
    const priorRows = Array.isArray(prior) ? prior : [];
    const regenRows = Array.isArray(regenerated) ? regenerated : [];
    const eps = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0;
    const priorByKey = new Map();
    for (const r of priorRows) priorByKey.set(identity(r), r);
    return regenRows.map((row) => {
      const p = priorByKey.get(identity(row));
      if (!p) return row;
      return Math.abs((row[metricField] ?? 0) - (p[metricField] ?? 0)) <= eps
        ? p
        : row;
    });
  };
}
