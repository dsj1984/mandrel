/**
 * kinds/coverage.js — per-kind module for the coverage baseline (Story #1891).
 *
 * Row shape: `{ path, lines, branches, functions }` (percentages 0–100).
 * Rollup math: per-axis denominator-weighted average is overkill for the
 * foundation — we ship the arithmetic mean across rows for the whole-repo
 * `*` key and each component. Per-row denominators land later when the
 * components resolver and per-component weighting (Story #1902, #1919)
 * arrive; the rollup signature is stable so callers don't churn.
 */

import { canonicalise } from '../path-canon.js';

export const name = 'coverage';
export const keyField = 'path';
const KERNEL_VERSION = '1.0.0';

export function kernelVersion() {
  return KERNEL_VERSION;
}

export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    lines: roundPct(row.lines),
    branches: roundPct(row.branches),
    functions: roundPct(row.functions),
  };
}

function roundPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path));
}

function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return { lines: 0, branches: 0, functions: 0 };
  }
  let l = 0;
  let b = 0;
  let f = 0;
  for (const row of rows) {
    l += row.lines ?? 0;
    b += row.branches ?? 0;
    f += row.functions ?? 0;
  }
  return {
    lines: Number((l / rows.length).toFixed(2)),
    branches: Number((b / rows.length).toFixed(2)),
    functions: Number((f / rows.length).toFixed(2)),
  };
}

export function rollup(rows, components = []) {
  const out = { '*': aggregate(rows) };
  for (const c of components ?? []) {
    const matched = (rows ?? []).filter((r) => componentMatches(c, r.path));
    out[c.name] = aggregate(matched);
  }
  return out;
}

function componentMatches(component, path) {
  if (!component || typeof component.includes !== 'string') return false;
  return (
    path === component.includes || path.startsWith(`${component.includes}/`)
  );
}
