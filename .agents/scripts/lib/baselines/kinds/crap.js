/**
 * kinds/crap.js — per-kind module for the CRAP baseline (Story #1891).
 *
 * Row shape: `{ path, method, startLine, crap }`. The legacy on-disk
 * baseline uses `file` instead of `path`; the per-kind v2 envelope schema
 * settles on `path` to match every other kind. The migration in Task
 * #1901 emits `path`; Story #1895 then regenerates the on-disk baseline
 * through the new writer, and Story #1892 updates the reader to consume
 * `path`.
 *
 * `kernelVersion()` returns the installed `typhonjs-escomplex` package
 * version — the CRAP score depends on escomplex's cyclomatic-complexity
 * output, so drift in that dependency invalidates every committed row.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';

export const name = 'crap';
export const keyField = 'path';

const __filename = fileURLToPath(import.meta.url);

/**
 * Resolve the running `typhonjs-escomplex` version by walking up from this
 * module's directory and reading the nearest
 * `node_modules/typhonjs-escomplex/package.json`. Returns `'0.0.0'` when
 * the dependency cannot be found — callers treat that sentinel as
 * "unknown environment" and the writer refuses to persist a baseline.
 *
 * @returns {string}
 */
export function kernelVersion() {
  let dir = path.dirname(__filename);
  const { root } = path.parse(dir);
  while (true) {
    const pkgPath = path.join(
      dir,
      'node_modules',
      'typhonjs-escomplex',
      'package.json',
    );
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (parsed && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        // fall through to parent lookup
      }
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

export function projectRow(row) {
  return {
    path: canonicalise(row.path ?? row.file),
    method: row.method,
    startLine: row.startLine,
    crap: row.crap,
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.method.localeCompare(b.method);
  });
}

function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return { p50: 0, p95: 0, max: 0, methodsAbove20: 0 };
  }
  const sorted = [...rows].map((r) => r.crap).sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    methodsAbove20: sorted.filter((c) => c > 20).length,
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  // Nearest-rank percentile — keeps the rollup integer-friendly without
  // pulling in a stats dep.
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
 * Pure compare(head, base) for the CRAP kind. Diffs rows by the
 * `path::method@startLine` composite identity (per-method granularity).
 *
 * Higher CRAP = worse. A row regresses when its crap score increases vs
 * base; improves when it decreases; unchanged when equal. New methods
 * with crap > 0 regress; removed methods with crap > 0 improve.
 *
 * No I/O. No process exit. No friction emission.
 */
export function compare(head, base) {
  const headRows = Array.isArray(head?.rows) ? head.rows : [];
  const baseRows = Array.isArray(base?.rows) ? base.rows : [];
  const baseByKey = new Map();
  for (const r of baseRows) baseByKey.set(crapRowKey(r), r);
  const seen = new Set();
  const regressions = [];
  const improvements = [];
  const unchanged = [];
  for (const h of headRows) {
    const key = crapRowKey(h);
    seen.add(key);
    const b = baseByKey.get(key);
    if (!b) {
      if ((h.crap ?? 0) > 0) regressions.push({ key, head: h, base: null });
      else unchanged.push({ key, head: h, base: null });
      continue;
    }
    const delta = (h.crap ?? 0) - (b.crap ?? 0);
    if (delta > 0) regressions.push({ key, head: h, base: b });
    else if (delta < 0) improvements.push({ key, head: h, base: b });
    else unchanged.push({ key, head: h, base: b });
  }
  for (const b of baseRows) {
    const key = crapRowKey(b);
    if (seen.has(key)) continue;
    if ((b.crap ?? 0) > 0) improvements.push({ key, head: null, base: b });
    else unchanged.push({ key, head: null, base: b });
  }
  return { regressions, improvements, unchanged };
}

function crapRowKey(row) {
  return `${row.path}::${row.method}@${row.startLine}`;
}

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}

/**
 * Pure stabilizer for s-stability-epsilon (Story #1964). CRAP rows match
 * by the composite `path::method@startLine` identity. Sub-epsilon CRAP
 * deltas resolve to the prior row bytes; missing-prior rows fall through.
 *
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} prior
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} regenerated
 * @param {number} epsilon non-negative absolute tolerance on CRAP
 * @returns {Array<object>}
 */
export function applyEpsilon(prior, regenerated, epsilon) {
  const priorRows = Array.isArray(prior) ? prior : [];
  const regenRows = Array.isArray(regenerated) ? regenerated : [];
  const eps = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0;
  const priorByKey = new Map();
  for (const r of priorRows) priorByKey.set(crapRowKey(r), r);
  return regenRows.map((row) => {
    const p = priorByKey.get(crapRowKey(row));
    if (!p) return row;
    return Math.abs((row.crap ?? 0) - (p.crap ?? 0)) <= eps ? p : row;
  });
}

/**
 * Pure scope-aware merge for s-diff-scoped-writes (Story #1974). CRAP rows
 * match identity by the composite `path::method@startLine`, but the scope
 * filter applies on `path` alone (a Story diff identifies files, not
 * methods). In diff mode, rows whose `path` is OUTSIDE `scope.files` are
 * preserved from `prior` verbatim — including every method on that file.
 * In full mode (or no scope), regenerated wins everywhere.
 *
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} prior
 * @param {Array<{path: string, method: string, startLine: number, crap: number}>} regenerated
 * @param {{mode: 'full'|'diff', files: Set<string>}|null|undefined} scope
 * @returns {Array<object>}
 */
export function mergeRows(prior, regenerated, scope) {
  return mergeRowsByScope({
    prior,
    regenerated,
    scope,
    scopeKey: (row) => row.path,
    identity: (row) => crapRowKey(row),
  });
}
