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

import { componentMatches } from '../component-matcher.js';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';

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

/**
 * Pure compare(head, base) for the lint kind. Diffs rows by `path`.
 *
 * Classification (per row key):
 *   - regression: head has more errorCount or warningCount than base
 *   - improvement: head has fewer errorCount or warningCount than base
 *   - unchanged: counts match
 *
 * A row present in `head` but missing from `base` is treated as a new
 * row — a regression if it carries any errors/warnings, otherwise
 * unchanged. A row present in `base` but missing from `head` is treated
 * as an improvement when it had findings, otherwise unchanged.
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
    const headTotal = (h.errorCount ?? 0) + (h.warningCount ?? 0);
    if (!b) {
      if (headTotal > 0) regressions.push({ key: h.path, head: h, base: null });
      else unchanged.push({ key: h.path, head: h, base: null });
      continue;
    }
    const errDelta = (h.errorCount ?? 0) - (b.errorCount ?? 0);
    const warnDelta = (h.warningCount ?? 0) - (b.warningCount ?? 0);
    if (errDelta > 0 || warnDelta > 0) {
      regressions.push({ key: h.path, head: h, base: b });
    } else if (errDelta < 0 || warnDelta < 0) {
      improvements.push({ key: h.path, head: h, base: b });
    } else {
      unchanged.push({ key: h.path, head: h, base: b });
    }
  }
  for (const b of baseRows) {
    if (seen.has(b.path)) continue;
    const baseTotal = (b.errorCount ?? 0) + (b.warningCount ?? 0);
    if (baseTotal > 0) improvements.push({ key: b.path, head: null, base: b });
    else unchanged.push({ key: b.path, head: null, base: b });
  }
  return { regressions, improvements, unchanged };
}

/**
 * Pure stabilizer for s-stability-epsilon (Story #1964). The metric is
 * the maximum absolute delta across `errorCount` and `warningCount`. The
 * framework default for lint is epsilon 0 (counts are integer; any change
 * is meaningful), but the function honours any non-negative epsilon for
 * operator overrides. Missing-prior rows fall through.
 *
 * @param {Array<{path: string, errorCount: number, warningCount: number}>} prior
 * @param {Array<{path: string, errorCount: number, warningCount: number}>} regenerated
 * @param {number} epsilon non-negative absolute tolerance on count deltas
 * @returns {Array<object>}
 */
export function applyEpsilon(prior, regenerated, epsilon) {
  const priorRows = Array.isArray(prior) ? prior : [];
  const regenRows = Array.isArray(regenerated) ? regenerated : [];
  const eps = Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : 0;
  const priorByKey = new Map();
  for (const r of priorRows) priorByKey.set(r.path, r);
  return regenRows.map((row) => {
    const p = priorByKey.get(row.path);
    if (!p) return row;
    const errDelta = Math.abs((row.errorCount ?? 0) - (p.errorCount ?? 0));
    const warnDelta = Math.abs((row.warningCount ?? 0) - (p.warningCount ?? 0));
    return Math.max(errDelta, warnDelta) <= eps ? p : row;
  });
}

/**
 * Pure scope-aware merge for s-diff-scoped-writes (Story #1974). Lint rows
 * match by `path`. In diff mode, rows whose `path` is OUTSIDE
 * `scope.files` are preserved from `prior` verbatim; in-scope rows come
 * from `regenerated`. In full mode (or no scope), regenerated wins
 * everywhere.
 *
 * @param {Array<{path: string, errorCount: number, warningCount: number}>} prior
 * @param {Array<{path: string, errorCount: number, warningCount: number}>} regenerated
 * @param {{mode: 'full'|'diff', files: Set<string>}|null|undefined} scope
 * @returns {Array<object>}
 */
export function mergeRows(prior, regenerated, scope) {
  return mergeRowsByScope({
    prior,
    regenerated,
    scope,
    scopeKey: (row) => row.path,
  });
}
