/** Pure scaffold factory for the row-metric baseline kinds. */

import { componentMatches } from '../component-matcher.js';
import { mergeRowsByScope } from '../scope.js';

/**
 * `missingBasePolicy`: a head row with no base row is an `'addition'`
 * (default; never a regression) or is classified against a `'perfect'` base.
 * `removedRowPolicy`: a base row with no head row is classified against a
 * perfect head, or is an improvement when `when(baseRow)` holds.
 *
 * @param {{
 *   keyField: string,
 *   kernelVersion: string | (() => string),
 *   axes: string[],
 *   betterWhen: 'higher' | 'lower',
 *   aggregate: (rows: object[]) => Record<string, number>,
 *   missingBasePolicy?: 'addition' | 'perfect',
 *   removedRowPolicy?:
 *     | { kind: 'perfect-head' }
 *     | { kind: 'improvement-when', when: (row: object) => boolean },
 *   perfectRow?: (key: string) => object,
 * }} opts
 * @returns {{
 *   kernelVersion: () => string,
 *   rowIdentity: (row: object) => string,
 *   sortRows: (rows: object[]) => object[],
 *   rollup: (rows: object[], components?: object[]) => Record<string, object>,
 *   compare: (head: object, base: object) => object,
 *   applyEpsilon: (prior: object[], regenerated: object[], epsilon: number) => object[],
 *   mergeRows: (prior: object[], regenerated: object[], scope: object) => object[],
 * }}
 */
export function makeBaselineKind({
  keyField,
  kernelVersion,
  axes,
  betterWhen,
  aggregate,
  missingBasePolicy = 'addition',
  removedRowPolicy = { kind: 'improvement-when', when: () => false },
  perfectRow = null,
}) {
  const keyOf = (row) => row[keyField];
  const kernelVersionFn =
    typeof kernelVersion === 'function' ? kernelVersion : () => kernelVersion;

  /**
   * "Is this the same row" — distinct from `keyField` ("which component"),
   * though derived from it here. Callers must never rebuild it from `keyField`.
   *
   * @param {object} row
   * @returns {string}
   */
  function rowIdentity(row) {
    return String(keyOf(row));
  }

  function sortRows(rows) {
    return [...rows].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }

  function rollup(rows, components = []) {
    const out = { '*': aggregate(rows) };
    for (const c of components ?? []) {
      const matched = (rows ?? []).filter((r) => componentMatches(c, keyOf(r)));
      out[c.name] = aggregate(matched);
    }
    return out;
  }

  function classify(regressions, improvements, unchanged, key, head, base) {
    let down = false;
    let up = false;
    for (const axis of axes) {
      const delta = (head[axis] ?? 0) - (base[axis] ?? 0);
      const worse = betterWhen === 'higher' ? delta < 0 : delta > 0;
      const better = betterWhen === 'higher' ? delta > 0 : delta < 0;
      if (worse) down = true;
      else if (better) up = true;
    }
    if (down) regressions.push({ key, head, base });
    else if (up) improvements.push({ key, head, base });
    else unchanged.push({ key, head, base });
  }

  function compare(head, base) {
    const headRows = Array.isArray(head?.rows) ? head.rows : [];
    const baseRows = Array.isArray(base?.rows) ? base.rows : [];
    const baseByKey = new Map();
    for (const r of baseRows) baseByKey.set(keyOf(r), r);
    const seen = new Set();
    const regressions = [];
    const improvements = [];
    const unchanged = [];
    const additions = [];
    for (const h of headRows) {
      const key = keyOf(h);
      seen.add(key);
      const b = baseByKey.get(key);
      if (!b) {
        if (missingBasePolicy === 'addition') {
          additions.push({ key, head: h, base: null });
        } else {
          classify(
            regressions,
            improvements,
            unchanged,
            key,
            h,
            perfectRow(key),
          );
        }
        continue;
      }
      classify(regressions, improvements, unchanged, key, h, b);
    }
    for (const b of baseRows) {
      const key = keyOf(b);
      if (seen.has(key)) continue;
      if (removedRowPolicy.kind === 'perfect-head') {
        classify(regressions, improvements, unchanged, key, perfectRow(key), b);
      } else if (removedRowPolicy.when(b)) {
        improvements.push({ key, head: null, base: b });
      } else {
        unchanged.push({ key, head: null, base: b });
      }
    }
    if (missingBasePolicy === 'addition') {
      return { regressions, improvements, unchanged, additions };
    }
    return { regressions, improvements, unchanged };
  }

  function applyEpsilon(prior, regenerated, epsilon) {
    const priorRows = Array.isArray(prior) ? prior : [];
    const regenRows = Array.isArray(regenerated) ? regenerated : [];
    const eps = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0;
    const priorByKey = new Map();
    for (const r of priorRows) priorByKey.set(keyOf(r), r);
    return regenRows.map((row) => {
      const p = priorByKey.get(keyOf(row));
      if (!p) return row;
      let maxAxisDelta = 0;
      for (const axis of axes) {
        const d = Math.abs((row[axis] ?? 0) - (p[axis] ?? 0));
        if (d > maxAxisDelta) maxAxisDelta = d;
      }
      return maxAxisDelta <= eps ? p : row;
    });
  }

  function mergeRows(prior, regenerated, scope) {
    return mergeRowsByScope({
      prior,
      regenerated,
      scope,
      scopeKey: keyOf,
    });
  }

  return {
    kernelVersion: kernelVersionFn,
    rowIdentity,
    sortRows,
    rollup,
    compare,
    applyEpsilon,
    mergeRows,
  };
}
