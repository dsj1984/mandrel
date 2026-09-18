/**
 * Per-kind module for the Maintainability Index baseline. Row shape:
 * `{ path, mi }`; higher is better. New files are additions, never
 * regressions; a removed file with MI < 100 counts as an improvement.
 */

import { readBaselineAtRef } from '../../baseline-loader.js';
import { loadBaseline } from '../../gates/baseline-store.js';
import { getBaseline } from '../maintainability-baseline-io.js';
import { canonicalise } from '../path-canon.js';
import { percentile } from './_shared-metric.js';
import { kernelVersion as crapKernelVersion } from './crap.js';
import { makeBaselineKind } from './kind-factory.js';

export const name = 'maintainability';
export const keyField = 'path';

/**
 * Canonical paths the kernel cannot score; each entry needs a one-line
 * reason. Keep it empty: prefer a handler in `escomplex-ast-compat.js`, which
 * gets the file measured for every consumer.
 */
export const MAINTAINABILITY_EXCLUSIONS = Object.freeze(new Set());

/**
 * Drop excluded paths and any `mi === 0` row: real code never scores 0, so
 * 0 means a parse failure that would poison the min/p50 rollup.
 *
 * @template {{path: string, mi?: number}} R
 * @param {R[]} rows
 * @returns {R[]}
 */
export function filterExcludedRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row) => !MAINTAINABILITY_EXCLUSIONS.has(row?.path) && row?.mi !== 0,
  );
}

export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    mi: Number(row.mi),
  };
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

export const {
  kernelVersion,
  rowIdentity,
  sortRows,
  rollup,
  compare,
  applyEpsilon,
  mergeRows,
} = makeBaselineKind({
  keyField,
  // Shared escomplex kernel: drift invalidates both baselines.
  kernelVersion: crapKernelVersion,
  axes: ['mi'],
  betterWhen: 'higher',
  aggregate,
  missingBasePolicy: 'addition',
  removedRowPolicy: {
    kind: 'improvement-when',
    when: (b) => (b.mi ?? 0) < 100,
  },
});

// CLI-facing pure helpers for `check-maintainability.js`.

// `--json` report version; bump when the report shape changes.
export const MI_REPORT_KERNEL_VERSION = '1.1.0';

/**
 * Same shape as the CRAP `--json` report, minus `fixGuidance`.
 *
 * @param {Record<string, number>} scores
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

/** Returns the flat `{ path: mi }` map the comparators expect. */
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
  // An epic-ref read may return a non-object.
  if (epicRef && (parsed === null || typeof parsed !== 'object')) return {};
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
