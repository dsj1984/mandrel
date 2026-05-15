/**
 * kinds/mutation.js — per-kind module for the mutation-testing baseline
 * (Story #1891). Row shape: `{ path, score, killed, survived }`. Rollup
 * carries score/killed/survived/noCoverage. Stryker is the upstream
 * kernel; we pin a static `1.0.0` until a Mandrel-side retrofit story
 * wires the running Stryker version through (#1908).
 */

import { canonicalise } from '../path-canon.js';

export const name = 'mutation';
export const keyField = 'path';
const KERNEL_VERSION = '1.0.0';

export function kernelVersion() {
  return KERNEL_VERSION;
}

export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    score: Number(row.score),
    killed: Number(row.killed ?? 0),
    survived: Number(row.survived ?? 0),
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path));
}

function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return { score: 0, killed: 0, survived: 0, noCoverage: 0 };
  }
  let scoreSum = 0;
  let killed = 0;
  let survived = 0;
  for (const r of rows) {
    scoreSum += r.score ?? 0;
    killed += r.killed ?? 0;
    survived += r.survived ?? 0;
  }
  return {
    score: Number((scoreSum / rows.length).toFixed(2)),
    killed,
    survived,
    noCoverage: 0,
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

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}
