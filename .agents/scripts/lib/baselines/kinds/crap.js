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

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}
