/**
 * Per-kind module for the coverage baseline. Row shape:
 * `{ path, lines, branches, functions }` (0–100). The rollup is an
 * unweighted mean across rows. A removed path compares against a perfect head.
 */

import { canonicalise } from '../path-canon.js';
import { makeBaselineKind } from './kind-factory.js';

export const name = 'coverage';
export const keyField = 'path';

const COV_AXES = ['lines', 'branches', 'functions'];

export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    lines: roundPct(row.lines),
    branches: roundPct(row.branches),
    functions: roundPct(row.functions),
  };
}

function roundPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

function meanOf(rows, axis) {
  let sum = 0;
  for (const r of rows) sum += r[axis] ?? 0;
  return Number((sum / rows.length).toFixed(2));
}

function aggregate(rows) {
  if (!rows || rows.length === 0) {
    return { lines: 0, branches: 0, functions: 0 };
  }
  return {
    lines: meanOf(rows, 'lines'),
    branches: meanOf(rows, 'branches'),
    functions: meanOf(rows, 'functions'),
  };
}

function perfectCoverageRow(path) {
  return { path, lines: 100, branches: 100, functions: 100 };
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
  kernelVersion: '1.0.0',
  axes: COV_AXES,
  betterWhen: 'higher',
  aggregate,
  missingBasePolicy: 'addition',
  removedRowPolicy: { kind: 'perfect-head' },
  perfectRow: perfectCoverageRow,
});
