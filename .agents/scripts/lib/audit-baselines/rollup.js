/**
 * The `*` rollup a baseline's rows imply. Committed row-set baselines carry
 * none: a rollup rewritten on every refresh conflicted every concurrent merge.
 *
 * @module lib/audit-baselines/rollup
 */

import { KNOWN_KINDS } from '../baselines/envelope.js';
import { getKindModule } from '../baselines/kernel.js';

/**
 * @param {Array<object>} rows
 * @returns {{ filesAboveCeiling: number, methodsAboveCeiling: number, maxCyclomatic: number }}
 */
function cyclomaticRollup(rows) {
  let methods = 0;
  let max = 0;
  for (const row of rows) {
    methods += Number(row?.methodsAboveCeiling ?? 0);
    const rowMax = Number(row?.maxCyclomatic ?? 0);
    if (rowMax > max) max = rowMax;
  }
  return {
    filesAboveCeiling: rows.length,
    methodsAboveCeiling: methods,
    maxCyclomatic: max,
  };
}

/**
 * `null` for a kind without rollup arithmetic.
 *
 * @param {string} kind
 * @param {Array<object>} rows
 * @returns {object | null}
 */
export function rollupOfRows(kind, rows) {
  if (KNOWN_KINDS.includes(kind)) return getKindModule(kind).rollup(rows)['*'];
  if (kind === 'cyclomatic') return cyclomaticRollup(rows);
  return null;
}
