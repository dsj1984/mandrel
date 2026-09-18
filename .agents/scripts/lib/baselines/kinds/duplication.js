/**
 * Per-kind module for the duplication baseline (jscpd). Row shape:
 * `{ path, duplicatedLines, totalLines, percentage }`; lower is better. Bump
 * the static kernel version when the row shape or rollup math changes.
 */

import { canonicalise } from '../path-canon.js';
import { makeBaselineKind } from './kind-factory.js';

export const name = 'duplication';
export const keyField = 'path';

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

/** Recomputed from line counts; averaging percentages over-weights small files. */
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
  axes: ['percentage'],
  betterWhen: 'lower',
  aggregate,
  missingBasePolicy: 'addition',
  removedRowPolicy: {
    kind: 'improvement-when',
    when: (b) => (b.percentage ?? 0) > 0,
  },
});
