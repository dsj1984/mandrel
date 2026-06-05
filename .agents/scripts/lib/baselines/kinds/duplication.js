/**
 * kinds/duplication.js — per-kind module for the code-duplication (DRY)
 * baseline (Story #3664).
 *
 * Row shape: `{ path, duplicatedLines, totalLines, percentage }`. Each row
 * records how much of a single source file is copy-paste duplication, as
 * reported by a clone detector (jscpd). `percentage` is the per-file
 * duplication ratio in [0, 100]; `duplicatedLines` / `totalLines` are the
 * raw line counts the percentage derives from, kept so the whole-repo
 * rollup can recompute an exact aggregate ratio rather than averaging
 * per-file percentages (which would over-weight small files).
 *
 * Lower duplication is better, so the gate's floor direction is `lte`
 * (see `check-baselines/phases/floors.js#axisDirection`).
 *
 * `kernelVersion()` returns a static in-repo semver — the duplication
 * scorer is the in-repo scan + rollup contract (the jscpd output is
 * normalised before it reaches this module), so there is no upstream
 * library version to track the way CRAP/MI track `typhonjs-escomplex`.
 * Bump `KERNEL_VERSION` whenever the row shape or rollup math changes.
 */

import { componentMatches } from '../component-matcher.js';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';

export const name = 'duplication';
export const keyField = 'path';
const KERNEL_VERSION = '1.0.0';

export function kernelVersion() {
  return KERNEL_VERSION;
}

export function projectRow(row) {
  const duplicatedLines = Number(row.duplicatedLines ?? 0);
  const totalLines = Number(row.totalLines ?? 0);
  const percentage =
    row.percentage === undefined || row.percentage === null
      ? computePercentage(duplicatedLines, totalLines)
      : Number(row.percentage);
  return {
    path: canonicalise(row.path ?? row.file),
    duplicatedLines,
    totalLines,
    percentage: roundTo2(percentage),
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Exact aggregate duplication ratio: total duplicated lines / total lines
 * across the row set, expressed as a percentage. Averaging per-file
 * percentages would over-weight small files, so the rollup recomputes from
 * the raw line counts each row carries.
 */
function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return {
      percentage: 0,
      duplicatedLines: 0,
      totalLines: 0,
      filesWithDuplication: 0,
    };
  }
  let duplicatedLines = 0;
  let totalLines = 0;
  let filesWithDuplication = 0;
  for (const r of rows) {
    duplicatedLines += r.duplicatedLines ?? 0;
    totalLines += r.totalLines ?? 0;
    if ((r.duplicatedLines ?? 0) > 0) filesWithDuplication += 1;
  }
  return {
    percentage: roundTo2(computePercentage(duplicatedLines, totalLines)),
    duplicatedLines,
    totalLines,
    filesWithDuplication,
  };
}

function computePercentage(duplicatedLines, totalLines) {
  if (!Number.isFinite(totalLines) || totalLines <= 0) return 0;
  return (duplicatedLines / totalLines) * 100;
}

function roundTo2(value) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
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
 * Pure compare(head, base) for the duplication kind. Diffs rows by `path`.
 *
 * Higher duplication = worse. A row regresses when its `percentage`
 * increases vs base; improves when it decreases; unchanged when equal.
 * New paths (head has a row that base lacks) land in the `additions`
 * bucket — absolute-floor enforcement is the unified `check-baselines`
 * gate's job and runs independently, so a Story that lands a new file
 * never fails through the regression arm (mirrors crap/maintainability,
 * Story #2012). Removed paths (base has a row that head dropped) count as
 * improvements when they carried any duplication; the file is gone, so its
 * prior debt is gone too.
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
  const additions = [];
  for (const h of headRows) {
    seen.add(h.path);
    const b = baseByKey.get(h.path);
    if (!b) {
      additions.push({ key: h.path, head: h, base: null });
      continue;
    }
    const delta = (h.percentage ?? 0) - (b.percentage ?? 0);
    if (delta > 0) regressions.push({ key: h.path, head: h, base: b });
    else if (delta < 0) improvements.push({ key: h.path, head: h, base: b });
    else unchanged.push({ key: h.path, head: h, base: b });
  }
  for (const b of baseRows) {
    if (seen.has(b.path)) continue;
    if ((b.percentage ?? 0) > 0) {
      improvements.push({ key: b.path, head: null, base: b });
    } else {
      unchanged.push({ key: b.path, head: null, base: b });
    }
  }
  return { regressions, improvements, unchanged, additions };
}

/**
 * Pure stabilizer for s-stability-epsilon (Story #1964). Duplication rows
 * match by `path`. The metric is the absolute `percentage` delta. Sub-
 * epsilon deltas resolve to the prior bytes so env variance never rewrites
 * the on-disk baseline; missing-prior rows fall through.
 *
 * @param {Array<{path: string, percentage: number}>} prior
 * @param {Array<{path: string, percentage: number}>} regenerated
 * @param {number} epsilon non-negative absolute tolerance on percentage
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
    return Math.abs((row.percentage ?? 0) - (p.percentage ?? 0)) <= eps
      ? p
      : row;
  });
}

/**
 * Pure scope-aware merge for s-diff-scoped-writes (Story #1974).
 * Duplication rows match by `path`. In diff mode, rows whose `path` is
 * OUTSIDE `scope.files` are preserved from `prior` verbatim; in-scope rows
 * come from `regenerated`. In full mode (or no scope), regenerated wins
 * everywhere.
 *
 * @param {Array<{path: string, percentage: number}>} prior
 * @param {Array<{path: string, percentage: number}>} regenerated
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
