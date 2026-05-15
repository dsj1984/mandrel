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

/**
 * Pure compare(head, base) for the coverage kind. Diffs rows by `path`.
 * Higher percentages are better — a row regresses if any axis (lines,
 * branches, functions) drops vs base; improves if any axis rises with no
 * axis dropping; unchanged otherwise. New paths inherit a base of 100%
 * for each axis (so partial coverage on a new file lands as a
 * regression); dropped paths inherit a head of 100%.
 *
 * No I/O. No process exit. No friction emission.
 */
const COV_AXES = ['lines', 'branches', 'functions'];

export function compare(head, base) {
  const headRows = Array.isArray(head?.rows) ? head.rows : [];
  const baseRows = Array.isArray(base?.rows) ? base.rows : [];
  const baseByKey = new Map();
  for (const r of baseRows) baseByKey.set(r.path, r);
  const seen = new Set();
  const regressions = [];
  const improvements = [];
  const unchanged = [];
  for (const h of headRows) {
    seen.add(h.path);
    const b = baseByKey.get(h.path) ?? perfectCoverageRow(h.path);
    classifyCoverage(regressions, improvements, unchanged, h.path, h, b);
  }
  for (const b of baseRows) {
    if (seen.has(b.path)) continue;
    const h = perfectCoverageRow(b.path);
    classifyCoverage(regressions, improvements, unchanged, b.path, h, b);
  }
  return { regressions, improvements, unchanged };
}

function perfectCoverageRow(path) {
  return { path, lines: 100, branches: 100, functions: 100 };
}

function classifyCoverage(
  regressions,
  improvements,
  unchanged,
  key,
  head,
  base,
) {
  let down = false;
  let up = false;
  for (const axis of COV_AXES) {
    const delta = (head[axis] ?? 0) - (base[axis] ?? 0);
    if (delta < 0) down = true;
    else if (delta > 0) up = true;
  }
  if (down) regressions.push({ key, head, base });
  else if (up) improvements.push({ key, head, base });
  else unchanged.push({ key, head, base });
}

function componentMatches(component, path) {
  if (!component || typeof component.includes !== 'string') return false;
  return (
    path === component.includes || path.startsWith(`${component.includes}/`)
  );
}
