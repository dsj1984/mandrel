/**
 * kinds/_shared-metric.js — shared metric helpers for per-kind baseline
 * modules (Story #3646).
 *
 * Both `crap.js` and `maintainability.js` duplicate the same
 * percentile/rollup/compare/epsilon algorithm verbatim. This module
 * extracts the parametrised core so each kind imports the factories
 * and passes only what differs (aggregate fields, identity key function,
 * better-is-higher polarity, metric field name).
 *
 * Exports (all pure, no I/O):
 *   - percentile(sortedValues, p)                     — verbatim shared
 *   - makeRollup({ aggregate })                       — rollup factory
 *   - makeAggregate({ fields })                       — aggregate factory
 *   - makeCompare({ identity, betterIsHigher })       — compare factory
 *   - makeEpsilon({ identity, metricField })          — epsilon factory
 */

import { componentMatches } from '../component-matcher.js';

// ---------------------------------------------------------------------------
// percentile
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over a **pre-sorted** ascending numeric array.
 * Keeps rollup values integer-friendly without pulling in a stats dep.
 *
 * @param {number[]} sortedValues - ascending-sorted array of numbers
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

// ---------------------------------------------------------------------------
// makeAggregate
// ---------------------------------------------------------------------------

/**
 * Build an aggregate-stats function for a set of metric fields.
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
 *
 * Each `fields` entry describes one metric:
 *   - `name`        — key in the returned stats object (e.g. `'p50'`)
 *   - `rowKey`      — property name on each row (e.g. `'crap'`, `'mi'`)
 *   - `percentiles` — list of percentile values to compute (e.g. `[50, 95]`)
 *   - `extras`      — optional function over the sorted values that returns
 *                     extra keys (e.g. `{ max, methodsAbove20 }`)
 *
 * The return value when `rows` is empty is built from the field list:
 * every percentile resolves to 0 and every extras key resolves to 0.
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

// ---------------------------------------------------------------------------
// makeRollup
// ---------------------------------------------------------------------------

/**
 * Build a rollup function that groups rows by component.
 *
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

// ---------------------------------------------------------------------------
// makeCompare
// ---------------------------------------------------------------------------

/**
 * Build a compare(head, base) function for a per-kind baseline.
 *
 * @param {{
 *   identity: (row: object) => string,
 *   betterIsHigher: boolean,
 *   metricField: string,
 *   removedIsImprovement?: (row: object) => boolean
 * }} opts
 *   - `identity`           — row → composite key string
 *   - `betterIsHigher`     — when true, delta > 0 is an improvement (MI);
 *                            when false, delta > 0 is a regression (CRAP)
 *   - `metricField`        — name of the numeric metric property on each row
 *   - `removedIsImprovement` — optional predicate deciding whether a removed
 *                              base row counts as an improvement; defaults to
 *                              `() => false` (no removal is auto-improvement)
 * @returns {(head: object, base: object) => {
 *   regressions: object[], improvements: object[],
 *   unchanged: object[], additions: object[]
 * }}
 */
export function makeCompare({
  identity,
  betterIsHigher,
  metricField,
  removedIsImprovement = () => false,
}) {
  return function compare(head, base) {
    const headRows = Array.isArray(head?.rows) ? head.rows : [];
    const baseRows = Array.isArray(base?.rows) ? base.rows : [];
    const baseByKey = new Map();
    for (const r of baseRows) baseByKey.set(identity(r), r);
    const seen = new Set();
    const regressions = [];
    const improvements = [];
    const unchanged = [];
    const additions = [];
    for (const h of headRows) {
      const key = identity(h);
      seen.add(key);
      const b = baseByKey.get(key);
      if (!b) {
        additions.push({ key, head: h, base: null });
        continue;
      }
      const delta = (h[metricField] ?? 0) - (b[metricField] ?? 0);
      const regressed = betterIsHigher ? delta < 0 : delta > 0;
      const improved = betterIsHigher ? delta > 0 : delta < 0;
      if (regressed) regressions.push({ key, head: h, base: b });
      else if (improved) improvements.push({ key, head: h, base: b });
      else unchanged.push({ key, head: h, base: b });
    }
    for (const b of baseRows) {
      const key = identity(b);
      if (seen.has(key)) continue;
      if (removedIsImprovement(b)) {
        improvements.push({ key, head: null, base: b });
      } else {
        unchanged.push({ key, head: null, base: b });
      }
    }
    return { regressions, improvements, unchanged, additions };
  };
}

// ---------------------------------------------------------------------------
// makeEpsilon
// ---------------------------------------------------------------------------

/**
 * Build an applyEpsilon(prior, regenerated, epsilon) function.
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
