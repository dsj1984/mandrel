/**
 * kinds.js — the two halves of the gate surface, and how to read a row out
 * of each (Story #4902).
 *
 * Mandrel's baseline surface is not one list. `delivery.quality.gates` is a
 * **closed** AJV schema of eight kinds, enforced by `check-baselines.js`.
 * Alongside it sit out-of-band **ratchet** baselines — dead exports (two
 * passes), import cycles, context budget — which no gate block declares and
 * only the CI baselines job runs. An engine that walks one half and calls it
 * "the baselines" silently drops the other; both halves are enumerated here.
 *
 * `GATE_KINDS` is derived from `GATES_SCHEMA` rather than re-typed, so a
 * ninth gate kind landing in the schema reaches this engine automatically.
 *
 * @module lib/audit-baselines/kinds
 */

import { GATES_SCHEMA } from '../config/gates/index.js';

/** The closed `delivery.quality.gates` kind set, in stable order. */
export const GATE_KINDS = Object.freeze(
  Object.keys(GATES_SCHEMA.properties).sort(),
);

/**
 * Out-of-band ratchet baselines: committed under `baselines/` and enforced
 * only by the CI baselines job, never by `check-baselines.js`.
 */
const RATCHET_KINDS = Object.freeze([
  'arch-cycles',
  'context-budget',
  'cyclomatic',
  'dead-exports',
  'dead-exports-production',
]);

/** Every kind the engine walks, gates first then ratchets. */
export const ALL_KINDS = Object.freeze([...GATE_KINDS, ...RATCHET_KINDS]);

/**
 * Resolve a kind's baseline path from config, falling back to the framework
 * default layout. Never hardcodes a consumer's location: a repo that moved
 * `baselines/crap.json` via `gates.crap.baselinePath` is followed.
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
 * Flatten `context-budget.json` into `{ id, value }` rows. Its three
 * sections all measure the same axis (bytes of context a file costs) under
 * different keys, so they fold into one row set rather than three.
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
 * Count how many allowlisted cycles each module participates in. A module in
 * three cycles is a worse architectural hotspot than one in a single cycle.
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
 * Count dead exports per file. The row grain is `{ file, symbol }`; the
 * hotspot grain is the file.
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
 * Build the `{ id, value }` extractor for an envelope-shaped gate kind.
 *
 * @param {string} idKey row property carrying the cluster identity
 * @param {string} metric row property carrying the measured value
 * @returns {(baseline: object) => Array<{ id: string, value: number }>}
 */
function envelopeRows(idKey, metric) {
  return (baseline) =>
    (baseline?.rows ?? [])
      .map((row) => ({ id: row?.[idKey], value: row?.[metric] }))
      .filter((r) => typeof r.id === 'string' && Number.isFinite(r.value));
}

/**
 * Fold `{ id, value }` rows into one whole-repo number.
 *
 * `TOTAL` is for **additive** metrics — dead-export symbols, context bytes,
 * cycle memberships — where the sum is the quantity the instrument measures.
 * `TALLY` is for **non-additive** ones — percentages, indices, scores — where
 * summing per-file values would fabricate a statistic; the honest whole-repo
 * number is how many rows are tracked, and the unit name says so.
 */
const TOTAL = (rows) => rows.reduce((sum, row) => sum + row.value, 0);
const TALLY = (rows) => rows.length;

/**
 * `[unit, fold]` per kind: the unit each kind's whole-repo total is
 * denominated in, and how its rows fold into it.
 *
 * This is the fix for the roll-up that counted **files** for every kind
 * (Story #4962). `dead-exports-production` moving 590 → 589 *symbols* across
 * 187 files on both sides read as a delta of 0, and a 421-byte context-budget
 * growth read as 0 too, because the fallback counted rows — a grain finer than
 * the file for dead exports and coarser than the byte for context budget.
 * Naming the unit is half the fix: an axis called `symbols` or `bytes` cannot
 * be re-read as a file count the way a bare `rowCount` was.
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
 * Per-kind row spec.
 *
 * - `metric`  — the axis a hotspot is measured on.
 * - `worse`   — which end of that axis is the bad end.
 * - `rows`    — baseline → `{ id, value }` pairs, already aggregated where
 *               the on-disk grain is finer than the file (dead exports,
 *               cycles).
 * - `idKind`  — what the cluster key names. Every kind but `bundle-size`
 *               (bundle names) keys on a repository file path.
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
 * The whole-repo rollup for a kind, or `null` when the kind does not carry
 * one. Ratchet baselines have no rollup — which is why stub detection asks
 * for an all-zero rollup rather than merely empty rows: an `arch-cycles`
 * baseline with zero cycles is a passing gate, not a dead instrument.
 *
 * @param {object | null} baseline
 * @returns {object | null}
 */
export function rollupOf(baseline) {
  const rollup = baseline?.rollup?.['*'];
  return rollup && typeof rollup === 'object' ? rollup : null;
}

/**
 * The whole-repo quantity a kind measures, in the unit it measures it in —
 * `{ unit, value }`, or `null` when the kind or the baseline is unreadable.
 *
 * This sits beside `rowCount` in `gateSurface[]` precisely because the two
 * disagree: `dead-exports-production` carries 589 rows across 187 files, so a
 * lone `rowCount: 187` reads as a symbol count and is not one.
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
 * The rollup a trend sample compares on. Gate kinds carry their own, already
 * axis-named; ratchet baselines carry none, so the whole-repo total stands in
 * under its own unit — "dead exports went 590 → 589 **symbols**" is exactly
 * the direction-of-travel question trend answers, and skipping the ratchet
 * half here would leave it visible in `gateSurface[]` but invisible in
 * `trend[]`.
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
