/**
 * kinds/lighthouse.js — per-kind module for the Lighthouse audit baseline
 * (Story #1891). Row shape: `{ route, performance, accessibility,
 * bestPractices, seo }`. The key field is `route` (a path-like string that
 * still passes the path-canon checks for absolute / `..` rejection).
 */

import { canonicalise } from '../path-canon.js';

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

function componentMatchesRoute(component, route) {
  if (!component || typeof component.includes !== 'string') return false;
  return route === component.includes || route.startsWith(`${component.includes}/`);
}
