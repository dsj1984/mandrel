/**
 * Findings severity histogram and per-component baseline rollup deltas.
 * Deltas are per rollup, not per row: row churn that moves no rollup is noise.
 * Pure, no I/O.
 */

import { groupRows, resolveComponents } from '../baselines/components.js';

/**
 * Non-standard severities are ignored.
 *
 * @param {Array<{ severity?: string }>|null|undefined} findings
 * @returns {{ critical: number, high: number, medium: number, low: number }}
 */
export function aggregateSummary(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings ?? []) {
    if (Object.hasOwn(summary, finding.severity)) {
      summary[finding.severity] += 1;
    }
  }
  return summary;
}

/**
 * The single halting rule: a surviving Critical finding halts delivery. Every
 * consumer routes through this rather than re-deriving `critical > 0`.
 * Accepts a severity count object or a `Finding[]`; a non-numeric `critical`
 * (e.g. an unparseable-body `null`) is not a halt — the caller owns that path.
 *
 * @param {{ critical?: unknown }|Array<{ severity?: string }>|null|undefined} input
 * @returns {boolean} `true` when at least one surviving Critical is present.
 */
export function hasSurvivingCritical(input) {
  if (Array.isArray(input)) {
    return input.some((finding) => finding?.severity === 'critical');
  }
  const critical = input?.critical;
  return typeof critical === 'number' && critical > 0;
}

/**
 * The envelope's own `rollup` when present, else recomputed from rows.
 *
 * @param {{ rollup?: object, rows?: Array<object> }} envelope
 * @param {Record<string, string[]>} components
 * @param {string} keyField
 * @param {(rows: Array<object>) => Record<string, number>} [recompute]
 * @returns {Record<string, Record<string, number>>}
 */
function resolveRollup(envelope, components, keyField, recompute) {
  if (envelope?.rollup && typeof envelope.rollup === 'object') {
    return envelope.rollup;
  }
  if (typeof recompute !== 'function') return { '*': {} };
  const buckets = groupRows(envelope?.rows ?? [], components, keyField);
  const out = {};
  for (const [name, rows] of Object.entries(buckets)) {
    out[name] = recompute(rows);
  }
  return out;
}

/**
 * One entry per differing axis. Informational only — floors are enforced by
 * `check-baselines.js`.
 *
 * @param {Record<string, number>|null|undefined} before
 * @param {Record<string, number>|null|undefined} after
 * @returns {Array<{ axis: string, before: number|null, after: number|null, delta: number|null }>}
 */
function diffAxes(before, after) {
  const axes = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const out = [];
  for (const axis of [...axes].sort()) {
    const b = before?.[axis];
    const a = after?.[axis];
    const bNum = typeof b === 'number' && Number.isFinite(b) ? b : null;
    const aNum = typeof a === 'number' && Number.isFinite(a) ? a : null;
    if (bNum === aNum) continue;
    const delta = bNum !== null && aNum !== null ? aNum - bNum : null;
    out.push({ axis, before: bNum, after: aNum, delta });
  }
  return out;
}

/**
 * @param {{
 *   before: { rollup?: object, rows?: Array<object> },
 *   after:  { rollup?: object, rows?: Array<object> },
 *   gateConfig?: object,
 *   keyField?: string,
 *   recompute?: (rows: Array<object>) => Record<string, number>,
 * }} params
 * @returns {Array<{
 *   component: string,
 *   axes: Array<{ axis: string, before: number|null, after: number|null, delta: number|null }>
 * }>}
 *   Changed components only, `*` first then alpha.
 */
export function aggregateBaselineDelta(params = {}) {
  const before = params.before ?? { rollup: {}, rows: [] };
  const after = params.after ?? { rollup: {}, rows: [] };
  const components = resolveComponents(params.gateConfig);
  const keyField =
    typeof params.keyField === 'string' && params.keyField.length > 0
      ? params.keyField
      : 'path';

  const beforeRollup = resolveRollup(
    before,
    components,
    keyField,
    params.recompute,
  );
  const afterRollup = resolveRollup(
    after,
    components,
    keyField,
    params.recompute,
  );

  const componentNames = new Set([
    '*',
    ...Object.keys(components),
    ...Object.keys(beforeRollup),
    ...Object.keys(afterRollup),
  ]);

  const entries = [];
  for (const name of componentNames) {
    const axes = diffAxes(beforeRollup[name], afterRollup[name]);
    if (axes.length === 0) continue;
    entries.push({ component: name, axes });
  }

  entries.sort((a, b) => {
    if (a.component === '*') return -1;
    if (b.component === '*') return 1;
    return a.component.localeCompare(b.component);
  });

  return entries;
}
