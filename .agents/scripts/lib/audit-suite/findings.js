/**
 * lib/audit-suite/findings.js — Findings histogram + baseline delta emitters.
 *
 * `aggregateSummary` (Story #963, Epic #946) populates the `metadata.summary`
 * block of the audit-suite envelope with a severity histogram.
 *
 * `aggregateBaselineDelta` (Task #1920, Epic #1786) reports per-component
 * rollup deltas between two committed baseline envelopes loaded via
 * `lib/baselines/reader.js`. It supersedes the prior row-by-row diff —
 * row-level deltas surfaced noise from churn that did not move any
 * component's rollup, drowning out the regressions that actually mattered.
 *
 * The delta function is **pure**: it takes the two `{ rollup, rows }`
 * envelopes returned by the reader plus the resolved components map and
 * returns a deterministic per-component delta. No filesystem I/O.
 */

import { groupRows, resolveComponents } from '../baselines/components.js';

/**
 * Pure: count findings into a {critical,high,medium,low} histogram. Findings
 * with severities outside that set are ignored, keeping the rendered summary
 * truthful even if upstream callers append non-standard severities.
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
 * Resolve the per-component rollup map for an envelope. When the envelope
 * already carries a `rollup` block (every writer-produced baseline does), we
 * trust it as the source of truth. When `rollup` is absent (raw test
 * fixtures, hand-written cases) we recompute from rows via the supplied
 * `recompute` callback so the function stays useful in both shapes.
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
 * Compare two component rollup objects (`{ axis: value }`) and emit one
 * delta entry per axis that differs. Pure.
 *
 * The direction is informational only — the audit emitter does not enforce
 * pass/fail policy; floor enforcement happens in `check-baselines.js`. We
 * report `before`, `after`, and the signed delta so a reviewer can read the
 * sign in context (lint count up = bad; coverage % down = bad).
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
 * Compute per-component rollup deltas between two baseline envelopes.
 *
 * Inputs are the shapes returned by `lib/baselines/reader.js#load(kind)`.
 * The function is pure — disk reads happen in the caller so the audit
 * emitter (and its tests) can drive synthetic before/after pairs.
 *
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
 *   One entry per component whose rollup changed. `*` always sorts first;
 *   the remainder is alpha. Components with no axis changes are omitted so
 *   an unchanged baseline yields `[]`.
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
