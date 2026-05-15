/**
 * kinds/maintainability.js — per-kind module for the Maintainability Index
 * (MI) baseline (Story #1891).
 *
 * Row shape: `{ path, mi }`. The legacy baseline shipped a flat `{ path: mi }`
 * map; the v2 envelope arrays each row explicitly so per-row metadata can
 * grow without churning the schema.
 *
 * MI is computed by the in-repo `escomplex-engine` kernel — same upstream
 * dependency family as CRAP — so the kernel version tracks
 * `typhonjs-escomplex` too.
 */

import { canonicalise } from '../path-canon.js';
import { kernelVersion as crapKernelVersion } from './crap.js';

export const name = 'maintainability';
export const keyField = 'path';

export function kernelVersion() {
  // MI and CRAP share the escomplex kernel — pin them together so a drift
  // in either always invalidates both baselines.
  return crapKernelVersion();
}

export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    mi: Number(row.mi),
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path));
}

function aggregate(rows) {
  if (!rows || rows.length === 0) return { min: 0, p50: 0, p95: 0 };
  const sorted = [...rows].map((r) => r.mi).sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return sortedValues[idx];
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
 * Pure compare(head, base) for the maintainability kind. Diffs rows by
 * `path`. Higher MI = better — a row regresses when its mi drops vs
 * base, improves when it rises, unchanged when equal. New paths inherit
 * a base of 100 (so any lower head registers as a regression); removed
 * paths inherit a head of 100 (so any lower base registers as an
 * improvement).
 *
 * No I/O. No process exit. No friction emission.
 */
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
    const b = baseByKey.get(h.path);
    const baseMi = b ? (b.mi ?? 0) : 100;
    const delta = (h.mi ?? 0) - baseMi;
    if (delta < 0) regressions.push({ key: h.path, head: h, base: b ?? null });
    else if (delta > 0)
      improvements.push({ key: h.path, head: h, base: b ?? null });
    else unchanged.push({ key: h.path, head: h, base: b ?? null });
  }
  for (const b of baseRows) {
    if (seen.has(b.path)) continue;
    const delta = 100 - (b.mi ?? 0);
    if (delta < 0) regressions.push({ key: b.path, head: null, base: b });
    else if (delta > 0) improvements.push({ key: b.path, head: null, base: b });
    else unchanged.push({ key: b.path, head: null, base: b });
  }
  return { regressions, improvements, unchanged };
}

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}
