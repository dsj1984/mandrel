/** Pure scaffold factory for the row-metric baseline kinds. */

/**
 * `newFileMinimum`: a head row with no base row that falls below it on any
 * axis is a regression against it. `renames`: head key → base key, so a
 * renamed row is compared against its old base row.
 *
 * @typedef {{
 *   newFileMinimum?: Record<string, number> | null,
 *   renames?: Map<string, string> | null,
 * }} CompareOptions
 */

import { componentMatches } from '../component-matcher.js';
import { mergeRowsByScope } from '../scope.js';

/**
 * `missingBasePolicy`: a head row with no base row is an `'addition'`
 * (default; never a regression) or is classified against a `'perfect'` base.
 * `removedRowPolicy`: a base row with no head row is classified against a
 * perfect head, or is an improvement when `when(baseRow)` holds.
 * `epsilonAxes`: the axes `applyEpsilon` measures (default `axes`); a prior
 * row is kept only when every compared axis outside them is unchanged.
 *
 * @param {{
 *   keyField: string,
 *   kernelVersion: string | (() => string),
 *   axes: string[],
 *   epsilonAxes?: string[],
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
 *   compare: (head: object, base: object, opts?: CompareOptions) => object,
 *   applyEpsilon: (prior: object[], regenerated: object[], epsilon: number) => object[],
 *   mergeRows: (prior: object[], regenerated: object[], scope: object) => object[],
 * }}
 */
export function makeBaselineKind({
  keyField,
  kernelVersion,
  axes,
  epsilonAxes = axes,
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

  function direction(head, base, axesToCompare = axes) {
    let up = false;
    for (const axis of axesToCompare) {
      const delta = (head[axis] ?? 0) - (base[axis] ?? 0);
      const signed = betterWhen === 'higher' ? delta : -delta;
      if (signed < 0) return 'down';
      if (signed > 0) up = true;
    }
    return up ? 'up' : 'same';
  }

  function classify(
    regressions,
    improvements,
    unchanged,
    key,
    head,
    base,
    extra,
  ) {
    const entry = { key, head, base, ...extra };
    const dir = direction(head, base);
    if (dir === 'down') regressions.push(entry);
    else if (dir === 'up') improvements.push(entry);
    else unchanged.push(entry);
  }

  /** A head row with no base row, under `missingBasePolicy: 'addition'`. */
  function judgeAddition(out, key, h, newFileMinimum) {
    const minAxes = newFileMinimum
      ? axes.filter((a) => Number.isFinite(newFileMinimum[a]))
      : [];
    const minimum = { [keyField]: key, ...newFileMinimum };
    if (minAxes.length > 0 && direction(h, minimum, minAxes) === 'down') {
      out.regressions.push({ key, head: h, base: minimum, newFile: true });
    } else {
      out.additions.push({ key, head: h, base: null });
    }
  }

  function compare(head, base, { newFileMinimum = null, renames = null } = {}) {
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
      const renamedFrom = baseByKey.has(key) ? undefined : renames?.get(key);
      if (renamedFrom !== undefined && baseByKey.has(renamedFrom)) {
        seen.add(renamedFrom);
        const b = baseByKey.get(renamedFrom);
        classify(regressions, improvements, unchanged, key, h, b, {
          renamedFrom,
        });
        continue;
      }
      const b = baseByKey.get(key);
      if (!b) {
        if (missingBasePolicy === 'addition') {
          judgeAddition({ regressions, additions }, key, h, newFileMinimum);
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
      return priorStillHolds(row, p, { axes, epsilonAxes, eps }) ? p : row;
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

function priorStillHolds(row, prior, { axes, epsilonAxes, eps }) {
  const drift = (axis) => Math.abs((row[axis] ?? 0) - (prior[axis] ?? 0));
  if (epsilonAxes.some((axis) => drift(axis) > eps)) return false;
  return axes.every(
    (axis) => epsilonAxes.includes(axis) || row[axis] === prior[axis],
  );
}
