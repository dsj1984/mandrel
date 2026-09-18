// scripts/lib/baselines/drift-detector.js
/**
 * drift-detector.js — full-scope baseline drift detection (Story #4776).
 *
 * Every enforcement site for the maintainability and CRAP baselines is
 * **diff-scoped**: close-validation, the pre-push hook and CI all compare
 * the files a branch touched against their committed rows. That is the
 * right per-PR trade — full-scope scoring on every push would be far too
 * expensive — but it has a structural blind spot. A file that is never
 * modified after its baseline row is written is never re-scored, so a
 * regression introduced *indirectly* (a dependency getting more complex, a
 * test deletion moving coverage underneath it) is invisible for as long as
 * nobody happens to touch that file.
 *
 * This module closes that hole with the check that is too expensive to run
 * per-PR and cheap enough to run on a schedule: re-score every target
 * directory in full, and report every row whose current score has moved
 * away from its baseline by more than the gate's tolerance — **in either
 * direction**. Drift, not regression: a row that silently improved is
 * equally strong evidence that the committed baseline no longer describes
 * the tree, and leaving it stale means the ratchet is anchored to a number
 * that no longer exists.
 *
 * Re-scoring routes through `refresh-service.resolveDefaultScorer` — the
 * same scorer that writes the baseline — so the detector cannot report two
 * implementations disagreeing with each other as drift in the tree.
 *
 * Pure-ish: the scorer and the baseline loader are both injectable, and the
 * module never writes anything, exits, or emits friction.
 *
 * The public surface is deliberately the three symbols the CLI actually
 * uses — `DRIFT_KINDS`, `detectBaselineDrift`, `formatDriftReport`. Every
 * internal helper below stays module-local and is exercised through them
 * (`detectBaselineDrift` forwards its `loadBaselineRows` / `scoreFullScope`
 * seams straight down). Exporting the helpers so tests could reach them
 * directly would ship five entry points nothing in production reaches —
 * exactly the orphaning this Story exists to stop.
 */

import { getKindModule } from '../../../.agents/scripts/lib/baselines/kernel.js';
import { load as loadBaseline } from '../../../.agents/scripts/lib/baselines/reader.js';
import { resolveDefaultScorer } from '../../../.agents/scripts/lib/baselines/refresh-service.js';
import { getQuality } from '../../../.agents/scripts/lib/config/quality.js';
import { resolveConfig } from '../../../.agents/scripts/lib/config-resolver.js';

/** The kinds whose rows carry a per-file/per-method score worth re-scoring. */
export const DRIFT_KINDS = Object.freeze(['maintainability', 'crap']);

/**
 * Per-kind identity, metric axis, and refresh remedy. `identity` must match
 * the granularity the kind's baseline rows are keyed at, or unchanged rows
 * masquerade as added/removed pairs.
 */
const KIND_SPECS = Object.freeze({
  maintainability: Object.freeze({
    metric: 'mi',
    identity: (row) => row.path,
    label: (row) => row.path,
    refreshCommand: 'npm run maintainability:update -- --full-scope',
    defaultTolerance: 0.5,
  }),
  crap: Object.freeze({
    metric: 'crap',
    identity: (row) => `${row.path}::${row.method}@${row.startLine}`,
    label: (row) => `${row.path}::${row.method} (line ${row.startLine})`,
    refreshCommand: 'npm run crap:update -- --full-scope',
    defaultTolerance: 0.001,
  }),
});

/**
 * Resolve the absolute drift tolerance for a kind: an explicit override
 * wins, then the gate's configured `tolerance.value`, then the per-kind
 * default.
 *
 * @param {string} kind
 * @param {object|undefined} gate resolved `delivery.quality.gates.<kind>`
 * @param {number|null|undefined} override
 * @returns {number}
 */
function resolveTolerance(kind, gate, override) {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.abs(override);
  }
  const configured = gate?.tolerance;
  if (configured?.kind === 'absolute') {
    const value = Number(configured.value);
    if (Number.isFinite(value)) return Math.abs(value);
  }
  return KIND_SPECS[kind].defaultTolerance;
}

/**
 * Normalise a scorer's raw rows into the kind's canonical on-disk row
 * shape, so scored rows and baseline rows are directly comparable. The
 * per-kind `projectRow` is the same projection the writer applies, which is
 * what makes the two sides comparable at all (it also reconciles the CRAP
 * scorer's `file` key with the envelope's `path`).
 *
 * @param {string} kind
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
function projectScoredRows(kind, rows) {
  const mod = getKindModule(kind);
  const out = [];
  for (const row of rows ?? []) {
    try {
      out.push(mod.projectRow(row));
    } catch {
      // A row the writer itself would refuse is not evidence of drift.
    }
  }
  return out;
}

/**
 * Diff two row sets by the kind's identity, classifying each key as
 * drifted / added / removed. Pure.
 *
 * @param {{ kind: string, baselineRows: Array<object>, currentRows: Array<object>, tolerance: number }} opts
 * @returns {{ drifted: Array<object>, added: Array<object>, removed: Array<object> }}
 */
function diffRows({ kind, baselineRows, currentRows, tolerance }) {
  const spec = KIND_SPECS[kind];
  const baseByKey = new Map();
  for (const row of baselineRows ?? []) baseByKey.set(spec.identity(row), row);

  const drifted = [];
  const added = [];
  const seen = new Set();

  for (const row of currentRows ?? []) {
    const key = spec.identity(row);
    seen.add(key);
    const base = baseByKey.get(key);
    if (!base) {
      added.push({ key, label: spec.label(row), current: row[spec.metric] });
      continue;
    }
    const before = Number(base[spec.metric] ?? 0);
    const after = Number(row[spec.metric] ?? 0);
    const delta = after - before;
    if (Math.abs(delta) <= tolerance) continue;
    drifted.push({
      key,
      label: spec.label(row),
      baseline: before,
      current: after,
      delta,
    });
  }

  const removed = [];
  for (const [key, row] of baseByKey) {
    if (seen.has(key)) continue;
    removed.push({ key, label: spec.label(row), baseline: row[spec.metric] });
  }

  return { drifted, added, removed };
}

/**
 * Re-score one kind full-scope and diff the result against its committed
 * baseline.
 *
 * Returns `{ ok: true, skipped: '<reason>' }` when the kind cannot be
 * checked (gate disabled, no baseline on disk, no scorer registered, the
 * scorer produced nothing) — an unscorable kind is not drift, and a
 * scheduled job must not go red because coverage happened to be absent.
 *
 * @param {{
 *   kind: string,
 *   cwd?: string,
 *   quality?: object,
 *   tolerance?: number|null,
 *   loadBaselineRows?: (kind: string, cwd: string) => Array<object>|null,
 *   scoreFullScope?: (kind: string, cwd: string) => Promise<Array<object>|null>|Array<object>|null,
 * }} opts
 * @returns {Promise<object>}
 */
async function detectKindDrift({
  kind,
  cwd = process.cwd(),
  quality,
  tolerance = null,
  loadBaselineRows = defaultLoadBaselineRows,
  scoreFullScope = defaultScoreFullScope,
}) {
  if (!Object.hasOwn(KIND_SPECS, kind)) {
    throw new Error(
      `[drift] unknown kind "${kind}"; expected one of ${DRIFT_KINDS.join(', ')}`,
    );
  }
  const gate = quality?.[kind];
  const spec = KIND_SPECS[kind];
  const base = { kind, refreshCommand: spec.refreshCommand };
  if (gate?.enabled === false) {
    return { ...base, ok: true, skipped: 'gate-disabled' };
  }

  const baselineRows = loadBaselineRows(kind, cwd);
  if (!Array.isArray(baselineRows) || baselineRows.length === 0) {
    return { ...base, ok: true, skipped: 'no-baseline' };
  }

  const raw = await scoreFullScope(kind, cwd);
  if (raw === null || raw === undefined) {
    return { ...base, ok: true, skipped: 'no-scorer' };
  }
  const currentRows = projectScoredRows(kind, raw);
  if (currentRows.length === 0) {
    return { ...base, ok: true, skipped: 'no-scored-rows' };
  }

  const resolvedTolerance = resolveTolerance(kind, gate, tolerance);
  const { drifted, added, removed } = diffRows({
    kind,
    baselineRows,
    currentRows,
    tolerance: resolvedTolerance,
  });

  return {
    ...base,
    ok: drifted.length === 0,
    tolerance: resolvedTolerance,
    scanned: currentRows.length,
    baselineRows: baselineRows.length,
    drifted,
    added,
    removed,
  };
}

/**
 * Run the drift check across several kinds.
 *
 * @param {{ kinds?: string[], cwd?: string, tolerance?: number|null, quality?: object }} opts
 * @returns {Promise<{ ok: boolean, results: Array<object> }>}
 */
export async function detectBaselineDrift({
  kinds = DRIFT_KINDS,
  cwd = process.cwd(),
  tolerance = null,
  quality,
  ...seams
} = {}) {
  let resolvedQuality = quality;
  if (!resolvedQuality) {
    try {
      resolvedQuality = getQuality(resolveConfig({ cwd })) ?? {};
    } catch {
      resolvedQuality = {};
    }
  }
  const results = [];
  for (const kind of kinds) {
    results.push(
      await detectKindDrift({
        kind,
        cwd,
        tolerance,
        quality: resolvedQuality,
        ...seams,
      }),
    );
  }
  return { ok: results.every((r) => r.ok), results };
}

/**
 * Default baseline loader — reads and schema-validates the committed
 * envelope. Returns `null` when it cannot be read, which the caller maps to
 * the `no-baseline` skip.
 */
function defaultLoadBaselineRows(kind, cwd) {
  try {
    return loadBaseline(kind, { cwd }).rows;
  } catch {
    return null;
  }
}

/**
 * Default full-scope scorer — the same scorer `refreshBaseline` uses, run
 * with `fullScope: true` so it walks every configured target directory
 * rather than a diff-derived file list.
 */
async function defaultScoreFullScope(kind, cwd) {
  const scorer = resolveDefaultScorer(kind, { cwd });
  if (typeof scorer !== 'function') return null;
  return await scorer(null, { fullScope: true, cwd });
}

/**
 * Render one kind's result as an operator-facing block: a per-row
 * before/after table plus the refresh remedy. Returns a string always —
 * a clean kind reports one line so a scheduled job's log shows it ran.
 *
 * @param {object} result
 * @returns {string}
 */
function formatKindDrift(result) {
  if (result.skipped) {
    return `[drift] ⏭ ${result.kind}: skipped (${result.skipped})`;
  }
  if (result.ok) {
    return `[drift] ✓ ${result.kind}: ${result.scanned} row(s) re-scored full-scope, no drift beyond ±${result.tolerance}`;
  }
  const width = Math.max(
    12,
    ...result.drifted.map((d) => String(d.label).length),
  );
  const lines = [
    `[drift] ✖ ${result.kind}: ${result.drifted.length} row(s) drifted beyond ±${result.tolerance} (${result.scanned} re-scored, ${result.baselineRows} in baseline)`,
    `  ${'ROW'.padEnd(width)}  ${'BASELINE'.padStart(10)}  ${'CURRENT'.padStart(10)}  ${'DELTA'.padStart(10)}`,
  ];
  for (const d of result.drifted) {
    lines.push(
      `  ${String(d.label).padEnd(width)}  ${d.baseline.toFixed(2).padStart(10)}  ${d.current
        .toFixed(2)
        .padStart(
          10,
        )}  ${(d.delta > 0 ? `+${d.delta.toFixed(2)}` : d.delta.toFixed(2)).padStart(10)}`,
    );
  }
  if (result.added.length > 0 || result.removed.length > 0) {
    lines.push(
      `  (${result.added.length} row(s) absent from baseline, ${result.removed.length} baseline row(s) absent from the tree)`,
    );
  }
  lines.push(
    `  Remedy: run \`${result.refreshCommand}\` and commit the refreshed baseline with a \`baseline-refresh:\` tagged subject (non-empty body).`,
  );
  return lines.join('\n');
}

/**
 * Render the whole run.
 *
 * @param {{ ok: boolean, results: Array<object> }} run
 * @returns {string}
 */
export function formatDriftReport(run) {
  const body = run.results.map(formatKindDrift).join('\n');
  const tail = run.ok
    ? '[drift] ✅ No baseline drift detected.'
    : '[drift] ❌ Baseline drift detected — the committed baselines no longer describe the tree.';
  return `${body}\n${tail}`;
}
