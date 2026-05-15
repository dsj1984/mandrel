/**
 * kinds/lint.js — per-kind module for the lint baseline (Story #1891).
 *
 * Declares:
 *   - `name`: kind identifier matching the per-kind schema filename.
 *   - `keyField`: row field used as the rollup key (`path` here).
 *   - `kernelVersion()`: the lint kernel is the in-repo formatter contract
 *      — it has no upstream library version to track, so we ship a static
 *      semver and bump it whenever the rollup math or row shape changes.
 *   - `rollup(rows, components)`: aggregate per-component lint counts.
 */

import { canonicalise } from '../path-canon.js';

export const name = 'lint';
export const keyField = 'path';
const KERNEL_VERSION = '1.0.0';

export function kernelVersion() {
  return KERNEL_VERSION;
}

/**
 * Aggregate `rows` into a `{ '*': {...}, [component]: {...} }` rollup. The
 * caller passes `components` as an array of `{ name, includes, excludes }`
 * objects. When `components` is empty or undefined the rollup carries only
 * the whole-repo `*` key.
 *
 * Rollup math for lint: sum of `errorCount` and `warningCount` across the
 * matching rows.
 */
export function rollup(rows, components = []) {
  const all = { errorCount: 0, warningCount: 0 };
  const buckets = new Map();
  for (const row of rows ?? []) {
    all.errorCount += row.errorCount ?? 0;
    all.warningCount += row.warningCount ?? 0;
    for (const c of components ?? []) {
      if (componentMatches(c, row.path)) {
        const existing = buckets.get(c.name) ?? {
          errorCount: 0,
          warningCount: 0,
        };
        existing.errorCount += row.errorCount ?? 0;
        existing.warningCount += row.warningCount ?? 0;
        buckets.set(c.name, existing);
      }
    }
  }
  const out = { '*': all };
  for (const [name, value] of buckets) out[name] = value;
  return out;
}

/**
 * Project a raw row into the canonical lint row shape. `path` is funnelled
 * through the canonicaliser — every kind exposes a `projectRow` so the
 * writer can normalise rows uniformly.
 */
export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    errorCount: row.errorCount ?? 0,
    warningCount: row.warningCount ?? 0,
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path));
}

function componentMatches(component, path) {
  // Components are exact-prefix matched on a path — the canonical
  // resolver (added in a sibling Story #1902) replaces this stub. For the
  // shared-writer foundation we only need a deterministic fallback so the
  // rollup runs without a components registry.
  if (!component || typeof component.includes !== 'string') return false;
  return path === component.includes || path.startsWith(`${component.includes}/`);
}
