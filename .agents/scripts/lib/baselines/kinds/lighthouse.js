/**
 * kinds/lighthouse.js — per-kind module for the Lighthouse audit baseline
 * (Story #1891). Row shape: `{ route, performance, accessibility,
 * bestPractices, seo }`. The key field is `route` (a path-like string that
 * still passes the path-canon checks for absolute / `..` rejection).
 */

import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';

export const name = 'lighthouse';
export const keyField = 'route';
const KERNEL_VERSION = '1.0.0';

export function kernelVersion() {
  return KERNEL_VERSION;
}

function canonRoute(route) {
  // Routes look like `/`, `/dashboard`, or `pricing` — strip the leading
  // slash so the canonicaliser doesn't see them as absolute paths.
  if (typeof route !== 'string') return canonicalise(route);
  const stripped = route.startsWith('/') ? route.slice(1) : route;
  if (stripped.length === 0) return '/';
  return canonicalise(stripped);
}

export function projectRow(row) {
  return {
    route: canonRoute(row.route),
    performance: Number(row.performance),
    accessibility: Number(row.accessibility),
    bestPractices: Number(row.bestPractices),
    seo: Number(row.seo),
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.route.localeCompare(b.route));
}

function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 };
  }
  const sum = { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 };
  for (const r of rows) {
    sum.performance += r.performance ?? 0;
    sum.accessibility += r.accessibility ?? 0;
    sum.bestPractices += r.bestPractices ?? 0;
    sum.seo += r.seo ?? 0;
  }
  return {
    performance: Number((sum.performance / rows.length).toFixed(2)),
    accessibility: Number((sum.accessibility / rows.length).toFixed(2)),
    bestPractices: Number((sum.bestPractices / rows.length).toFixed(2)),
    seo: Number((sum.seo / rows.length).toFixed(2)),
  };
}

export function rollup(rows, components = []) {
  const out = { '*': aggregate(rows) };
  for (const c of components ?? []) {
    const matched = (rows ?? []).filter((r) =>
      componentMatchesRoute(c, r.route),
    );
    out[c.name] = aggregate(matched);
  }
  return out;
}

/**
 * Pure compare(head, base) for the lighthouse kind. Diffs rows by `route`.
 *
 * Higher score = better. A row regresses when any of performance,
 * accessibility, bestPractices, or seo decreases vs the base. An
 * improvement requires at least one score to increase and none to
 * decrease. Otherwise the row is unchanged. New routes inherit a base of
 * 100 for each axis (so lower scores register as regressions); dropped
 * routes inherit a head of 100 (so a higher base registers as an
 * improvement).
 *
 * No I/O. No process exit. No friction emission.
 */
const LH_AXES = ['performance', 'accessibility', 'bestPractices', 'seo'];

export function compare(head, base) {
  const headRows = Array.isArray(head?.rows) ? head.rows : [];
  const baseRows = Array.isArray(base?.rows) ? base.rows : [];
  const baseByKey = new Map();
  for (const r of baseRows) baseByKey.set(r.route, r);
  const seen = new Set();
  const regressions = [];
  const improvements = [];
  const unchanged = [];
  for (const h of headRows) {
    seen.add(h.route);
    const b = baseByKey.get(h.route) ?? perfectLighthouseRow(h.route);
    classify(regressions, improvements, unchanged, h.route, h, b);
  }
  for (const b of baseRows) {
    if (seen.has(b.route)) continue;
    const h = perfectLighthouseRow(b.route);
    classify(regressions, improvements, unchanged, b.route, h, b);
  }
  return { regressions, improvements, unchanged };
}

function perfectLighthouseRow(route) {
  return {
    route,
    performance: 100,
    accessibility: 100,
    bestPractices: 100,
    seo: 100,
  };
}

function classify(regressions, improvements, unchanged, key, head, base) {
  let down = false;
  let up = false;
  for (const axis of LH_AXES) {
    const delta = (head[axis] ?? 0) - (base[axis] ?? 0);
    if (delta < 0) down = true;
    else if (delta > 0) up = true;
  }
  if (down) regressions.push({ key, head, base });
  else if (up) improvements.push({ key, head, base });
  else unchanged.push({ key, head, base });
}

function componentMatchesRoute(component, route) {
  if (!component || typeof component.includes !== 'string') return false;
  return (
    route === component.includes || route.startsWith(`${component.includes}/`)
  );
}

/**
 * Pure stabilizer for s-stability-epsilon (Story #1964). Lighthouse rows
 * match by `route`. The metric is the maximum absolute delta across the
 * four scoring axes. Sub-epsilon deltas resolve to the prior bytes;
 * missing-prior rows fall through.
 *
 * @param {Array<{route: string, performance: number, accessibility: number, bestPractices: number, seo: number}>} prior
 * @param {Array<{route: string, performance: number, accessibility: number, bestPractices: number, seo: number}>} regenerated
 * @param {number} epsilon non-negative absolute tolerance per axis
 * @returns {Array<object>}
 */
export function applyEpsilon(prior, regenerated, epsilon) {
  const priorRows = Array.isArray(prior) ? prior : [];
  const regenRows = Array.isArray(regenerated) ? regenerated : [];
  const eps = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0;
  const priorByKey = new Map();
  for (const r of priorRows) priorByKey.set(r.route, r);
  return regenRows.map((row) => {
    const p = priorByKey.get(row.route);
    if (!p) return row;
    let maxAxisDelta = 0;
    for (const axis of LH_AXES) {
      const d = Math.abs((row[axis] ?? 0) - (p[axis] ?? 0));
      if (d > maxAxisDelta) maxAxisDelta = d;
    }
    return maxAxisDelta <= eps ? p : row;
  });
}

/**
 * Pure scope-aware merge for s-diff-scoped-writes (Story #1974). Lighthouse
 * rows match by `route`. In diff mode, rows whose `route` is OUTSIDE
 * `scope.files` are preserved from `prior` verbatim; in-scope rows come
 * from `regenerated`. In full mode (or no scope), regenerated wins
 * everywhere.
 *
 * Note: lighthouse routes are not file paths, so the scope filter only
 * narrows naturally when callers seed `scope.files` with route strings.
 * Auto-refresh callers using a Story file diff will see no in-scope rows
 * and therefore preserve every prior row — which is the safe default for
 * a baseline that is not file-derived.
 *
 * @param {Array<{route: string, performance: number, accessibility: number, bestPractices: number, seo: number}>} prior
 * @param {Array<{route: string, performance: number, accessibility: number, bestPractices: number, seo: number}>} regenerated
 * @param {{mode: 'full'|'diff', files: Set<string>}|null|undefined} scope
 * @returns {Array<object>}
 */
export function mergeRows(prior, regenerated, scope) {
  return mergeRowsByScope({
    prior,
    regenerated,
    scope,
    scopeKey: (row) => row.route,
  });
}
