/**
 * Both halves of the baseline surface (gate kinds and out-of-band ratchets)
 * and how to read rows from each.
 *
 * @module lib/audit-baselines/kinds
 */

import { GATES_SCHEMA } from '../config/gates/index.js';

/** Derived from the schema so a new gate kind arrives automatically. */
export const GATE_KINDS = Object.freeze(
  Object.keys(GATES_SCHEMA.properties).sort(),
);

/** Enforced only by the CI baselines job, never by `check-baselines.js`. */
const RATCHET_KINDS = Object.freeze([
  'arch-cycles',
  'context-budget',
  'cyclomatic',
  'dead-exports',
  'dead-exports-production',
]);

export const ALL_KINDS = Object.freeze([...GATE_KINDS, ...RATCHET_KINDS]);

/**
 * Honours `gates.<kind>.baselinePath`, else `baselines/<kind>.json`.
 *
 * @param {string} kind
 * @param {object | null | undefined} quality resolved `delivery.quality`
 * @returns {string} repo-relative path
 */
export function baselinePathFor(kind, quality) {
  const configured = quality?.gates?.[kind]?.baselinePath;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured;
  }
  return `baselines/${kind}.json`;
}

/**
 * All three `context-budget.json` sections measure bytes, so they fold into
 * one row set.
 *
 * @param {object} baseline
 * @returns {Array<{ id: string, value: number }>}
 */
function contextBudgetRows(baseline) {
  const out = [];
  for (const tier of Object.values(baseline?.tiers ?? {})) {
    for (const f of tier?.files ?? []) out.push({ id: f.path, value: f.bytes });
  }
  for (const f of baseline?.agentBoot?.files ?? []) {
    out.push({ id: f.path, value: f.bytes });
  }
  for (const e of baseline?.workflowClosure?.entryPoints ?? []) {
    out.push({ id: e.path, value: e.reachableBytes });
  }
  return out.filter(
    (r) => typeof r.id === 'string' && Number.isFinite(r.value),
  );
}

/**
 * Allowlisted-cycle memberships per module.
 *
 * @param {object} baseline
 * @returns {Array<{ id: string, value: number }>}
 */
function archCycleRows(baseline) {
  const counts = new Map();
  for (const cycle of baseline?.cycles ?? []) {
    for (const member of new Set(cycle ?? [])) {
      counts.set(member, (counts.get(member) ?? 0) + 1);
    }
  }
  return [...counts].map(([id, value]) => ({ id, value }));
}

/**
 * Dead exports per file (rows are per symbol).
 *
 * @param {object} baseline
 * @returns {Array<{ id: string, value: number }>}
 */
function deadExportRows(baseline) {
  const counts = new Map();
  for (const row of baseline?.rows ?? []) {
    if (typeof row?.file !== 'string') continue;
    counts.set(row.file, (counts.get(row.file) ?? 0) + 1);
  }
  return [...counts].map(([id, value]) => ({ id, value }));
}

/**
 * @param {string} idKey
 * @param {string} metric
 * @returns {(baseline: object) => Array<{ id: string, value: number }>}
 */
function envelopeRows(idKey, metric) {
  return (baseline) =>
    (baseline?.rows ?? [])
      .map((row) => ({ id: row?.[idKey], value: row?.[metric] }))
      .filter((r) => typeof r.id === 'string' && Number.isFinite(r.value));
}

/**
 * `TOTAL` sums additive metrics; `TALLY` counts rows for non-additive ones
 * (percentages, indices), where a sum would fabricate a statistic.
 */
const TOTAL = (rows) => rows.reduce((sum, row) => sum + row.value, 0);
const TALLY = (rows) => rows.length;

/**
 * `[unit, fold]` per kind. The named unit keeps a whole-repo total from being
 * misread as a file count.
 */
const TREND_UNITS = Object.freeze({
  'bundle-size': ['rawKb', TOTAL],
  coverage: ['filesTracked', TALLY],
  crap: ['filesTracked', TALLY],
  duplication: ['filesTracked', TALLY],
  maintainability: ['filesTracked', TALLY],
  mutation: ['filesTracked', TALLY],
  'arch-cycles': ['cycleMemberships', TOTAL],
  'context-budget': ['bytes', TOTAL],
  cyclomatic: ['filesTracked', TALLY],
  'dead-exports': ['symbols', TOTAL],
  'dead-exports-production': ['symbols', TOTAL],
});

/**
 * Per-kind row spec: hotspot `metric`, which end is `worse`, `rows`
 * extractor (aggregated to file grain), and what the `idKind` key names.
 */
export const KIND_SPECS = Object.freeze({
  'bundle-size': {
    metric: 'rawKb',
    worse: 'higher',
    idKind: 'bundle',
    rows: envelopeRows('bundle', 'rawKb'),
  },
  coverage: {
    metric: 'lines',
    worse: 'lower',
    idKind: 'path',
    rows: envelopeRows('path', 'lines'),
  },
  crap: {
    metric: 'crap',
    worse: 'higher',
    idKind: 'path',
    rows: envelopeRows('path', 'crap'),
  },
  duplication: {
    metric: 'percentage',
    worse: 'higher',
    idKind: 'path',
    rows: envelopeRows('path', 'percentage'),
  },
  maintainability: {
    metric: 'mi',
    worse: 'lower',
    idKind: 'path',
    rows: envelopeRows('path', 'mi'),
  },
  mutation: {
    metric: 'score',
    worse: 'lower',
    idKind: 'path',
    rows: envelopeRows('path', 'score'),
  },
  'arch-cycles': {
    metric: 'cycleMemberships',
    worse: 'higher',
    idKind: 'path',
    rows: archCycleRows,
  },
  'context-budget': {
    metric: 'bytes',
    worse: 'higher',
    idKind: 'path',
    rows: contextBudgetRows,
  },
  cyclomatic: {
    metric: 'maxCyclomatic',
    worse: 'higher',
    idKind: 'path',
    rows: envelopeRows('file', 'maxCyclomatic'),
  },
  'dead-exports': {
    metric: 'deadExports',
    worse: 'higher',
    idKind: 'path',
    rows: deadExportRows,
  },
  'dead-exports-production': {
    metric: 'deadExports',
    worse: 'higher',
    idKind: 'path',
    rows: deadExportRows,
  },
});

/**
 * The `*` rollup, or `null` (ratchets carry none — a zero-cycle `arch-cycles`
 * is a passing gate, not a stub).
 *
 * @param {object | null} baseline
 * @returns {object | null}
 */
export function rollupOf(baseline) {
  const rollup = baseline?.rollup?.['*'];
  return rollup && typeof rollup === 'object' ? rollup : null;
}

/**
 * Whole-repo quantity in its own unit; differs from `rowCount` whenever the
 * row grain is not the unit.
 *
 * @param {string} kind
 * @param {object | null} baseline
 * @returns {{ unit: string, value: number } | null}
 */
export function measuredTotalOf(kind, baseline) {
  const spec = KIND_SPECS[kind];
  const denomination = TREND_UNITS[kind];
  if (!baseline || !spec || !denomination) return null;
  const [unit, fold] = denomination;
  return { unit, value: fold(spec.rows(baseline)) };
}

/**
 * Trend comparison rollup: the declared one, else (ratchets) the measured
 * total under its unit, so ratchets appear in `trend[]` too.
 *
 * @param {string} kind
 * @param {object | null} baseline
 * @returns {object | null}
 */
export function trendRollupOf(kind, baseline) {
  if (!baseline) return null;
  const declared = rollupOf(baseline);
  if (declared) return declared;
  const measured = measuredTotalOf(kind, baseline);
  return measured ? { [measured.unit]: measured.value } : null;
}
