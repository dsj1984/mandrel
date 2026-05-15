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

/**
 * Pure compare(head, base) for the mutation kind. Diffs rows by `path`.
 * Higher score = better — a row regresses when its score drops vs base,
 * improves when it rises, unchanged when equal. New paths inherit a base
 * score of 100 (so any lower head registers as a regression); removed
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
    const baseScore = b ? (b.score ?? 0) : 100;
    const delta = (h.score ?? 0) - baseScore;
    if (delta < 0) regressions.push({ key: h.path, head: h, base: b ?? null });
    else if (delta > 0)
      improvements.push({ key: h.path, head: h, base: b ?? null });
    else unchanged.push({ key: h.path, head: h, base: b ?? null });
  }
  for (const b of baseRows) {
    if (seen.has(b.path)) continue;
    const delta = 100 - (b.score ?? 0);
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
