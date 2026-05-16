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

import { readBaselineAtRef } from '../../baseline-loader.js';
import { loadBaseline } from '../../gates/baseline-store.js';
import { Logger } from '../../Logger.js';
import { getBaseline } from '../../maintainability-utils.js';
import {
  applyFloorPolicy,
  formatViolation,
  loadFloorConfig,
  parseFloorFlag,
} from '../../quality-floors.js';
import { canonicalise } from '../path-canon.js';
import { mergeRowsByScope } from '../scope.js';
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
 * base, improves when it rises, unchanged when equal. New paths (head
 * has a row that base lacks) land in the `additions` bucket; absolute-
 * floor enforcement is the unified `check-baselines` gate's job and runs
 * independently. Removed paths (base has a row that head dropped) count
 * as improvements when their MI was non-perfect; the file is gone, so
 * its prior debt is gone too.
 *
 * Story #2012 — new files MUST NOT register as regressions. The prior
 * behaviour treated missing-in-base as base.mi = 100 and any real-world
 * MI under 100 (i.e., almost every file) flipped to a regression.
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
    const delta = (h.mi ?? 0) - (b.mi ?? 0);
    if (delta < 0) regressions.push({ key: h.path, head: h, base: b });
    else if (delta > 0) improvements.push({ key: h.path, head: h, base: b });
    else unchanged.push({ key: h.path, head: h, base: b });
  }
  for (const b of baseRows) {
    if (seen.has(b.path)) continue;
    if ((b.mi ?? 0) < 100) {
      improvements.push({ key: b.path, head: null, base: b });
    } else {
      unchanged.push({ key: b.path, head: null, base: b });
    }
  }
  return { regressions, improvements, unchanged, additions };
}

function componentMatches(component, p) {
  if (!component || typeof component.includes !== 'string') return false;
  return p === component.includes || p.startsWith(`${component.includes}/`);
}

/**
 * Pure stabilizer for s-stability-epsilon (Story #1964). Folds sub-epsilon
 * MI deltas back to the prior bytes so env variance does not rewrite the
 * on-disk baseline. Missing-prior rows fall through to the regenerated
 * row.
 *
 * @param {Array<{path: string, mi: number}>} prior
 * @param {Array<{path: string, mi: number}>} regenerated
 * @param {number} epsilon non-negative absolute tolerance on MI
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
    return Math.abs((row.mi ?? 0) - (p.mi ?? 0)) <= eps ? p : row;
  });
}

/**
 * Pure scope-aware merge for s-diff-scoped-writes (Story #1974). MI rows
 * match by `path`. In diff mode, rows whose `path` is OUTSIDE
 * `scope.files` are preserved from `prior` verbatim; in-scope rows come
 * from `regenerated`. In full mode (or no scope), regenerated wins
 * everywhere.
 *
 * @param {Array<{path: string, mi: number}>} prior
 * @param {Array<{path: string, mi: number}>} regenerated
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

// ---------------------------------------------------------------------------
// CLI-facing pure helpers (Story #1981, Task #1989).
// Hoisted from `.agents/scripts/check-maintainability.js`.
// ---------------------------------------------------------------------------

// Envelope version for the --json parity output. Bump when the report
// shape changes so downstream agent workflows can detect breaks without
// guessing. 1.1.0 — TypeScript support landed in 5.29.0.
export const MI_REPORT_KERNEL_VERSION = '1.1.0';

/**
 * Pure: build the MI parity envelope. Shape matches the CRAP `--json`
 * output: `{ kernelVersion, summary, violations }` sans `fixGuidance`
 * (MI scores don't decompose along the two CRAP axes).
 *
 * @param {Record<string, number>} scores current MI scores keyed by file
 * @param {{
 *   regressions?: number,
 *   newFiles?: number,
 *   improvements?: number,
 *   regressedFiles?: Array<{file: string, current: number, baseline: number, drop: number}>
 * }} stats
 * @param {{ scope?: 'diff' | 'full', diffRef?: string | null }} [scopeInfo]
 */
export function buildMaintainabilityReport(scores, stats, scopeInfo) {
  const total = Object.keys(scores ?? {}).length;
  const violations = (stats?.regressedFiles ?? []).map((r) => ({
    file: r.file,
    current: r.current,
    baseline: r.baseline,
    drop: r.drop,
    kind: 'regression',
  }));
  const scope = scopeInfo?.scope === 'full' ? 'full' : 'diff';
  const diffRef = scope === 'full' ? null : (scopeInfo?.diffRef ?? null);
  return {
    kernelVersion: MI_REPORT_KERNEL_VERSION,
    summary: {
      total,
      regressions: stats?.regressions ?? 0,
      newFiles: stats?.newFiles ?? 0,
      improvements: stats?.improvements ?? 0,
      scope,
      diffRef,
    },
    violations,
  };
}

/** Thin wrapper: delegate to baseline-store with MI-specific defaults. */
export function loadMaintainabilityBaseline({
  baselinePath,
  epicRef,
  readBaseline = getBaseline,
  readAtRef = readBaselineAtRef,
  logger = console,
}) {
  const parsed = loadBaseline({
    baselinePath,
    epicRef,
    readAtRef,
    readFromTree: ({ baselinePath: p }) => readBaseline(p),
    logger,
    label: 'Maintainability',
  });
  // Epic-ref read may return a non-object — coerce to {} so downstream
  // `Object.entries` / `Object.keys` never throws.
  if (epicRef && (parsed === null || typeof parsed !== 'object')) return {};
  // Story #1895: the on-disk baseline switched from the flat
  // `{ path: mi }` map to the canonical envelope shape. Project envelope
  // back to the legacy flat shape so downstream comparators keep working.
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.rows) &&
    typeof parsed.$schema === 'string'
  ) {
    const flat = {};
    for (const row of parsed.rows) {
      if (row && typeof row.path === 'string' && typeof row.mi === 'number') {
        flat[row.path] = row.mi;
      }
    }
    return flat;
  }
  return parsed;
}

/**
 * Story #1602 — absolute MI floor (≥70 by default). Pure decision
 * helper: returns `0` when the gate is skipped or all files clear the
 * floor, `1` when one or more files are below floor. The CLI wrapper
 * translates the return into a `process.exit(1)`; tests can drive the
 * helper directly and assert the return code.
 *
 * `options.floors` overrides the `loadFloorConfig()` default — used by
 * tests and by callers that have already loaded the floor config.
 *
 * Opt-out: pass `--floor=off` in `argv` for baseline-update runs.
 *
 * @returns {0 | 1}
 */
export function enforceMaintainabilityFloor(scores, argv, options = {}) {
  if (!parseFloorFlag(argv)) {
    Logger.info('[Maintainability] ⚠️  floor gate skipped (--floor=off)');
    return 0;
  }
  const floors = options.floors ?? loadFloorConfig();
  const records = Object.entries(scores).map(([file, mi]) => ({ file, mi }));
  // Story #2029: advertise every path-override that matched at least one
  // scored record. The line is emitted unconditionally on pass AND fail so
  // active overrides cannot hide behind a green CI run.
  logActivePathOverrides(records, floors);
  const { violations } = applyFloorPolicy(records, floors, 'maintainability');
  if (violations.length === 0) return 0;
  Logger.error(
    `[Maintainability] ❌ Absolute MI floor violated (${violations.length} file(s); floor=${floors.maintainability}):`,
  );
  for (const v of violations) {
    Logger.error(`                ${formatViolation(v)}`);
  }
  Logger.error(
    '[Maintainability] Refactor the flagged file(s); the floor is non-negotiable. Use `--floor=off` only when running `maintainability:update`.',
  );
  return 1;
}

/**
 * Story #2029: emit one Logger.info line per maintainability path
 * override that matched at least one record in this run. Quiet when
 * no overrides are configured or none matched.
 *
 * @param {Array<{file: string}>} records
 * @param {import('../../quality-floors.js').FloorConfig} floors
 */
function logActivePathOverrides(records, floors) {
  const overrides = floors?.pathOverrides;
  if (!(overrides instanceof Map) || overrides.size === 0) return;
  const seenPaths = new Set(records.map((r) => r?.file).filter(Boolean));
  for (const [pathKey, entry] of overrides) {
    if (!seenPaths.has(pathKey)) continue;
    if (!Object.hasOwn(entry, 'maintainability')) continue;
    Logger.info(
      `[Maintainability] ${pathKey}: maintainability floor relaxed to ${entry.maintainability} per ${entry.follow_up}`,
    );
  }
}
