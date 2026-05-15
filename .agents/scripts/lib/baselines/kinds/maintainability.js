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

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}
