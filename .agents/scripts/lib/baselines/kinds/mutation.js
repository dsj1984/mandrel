/**
 * Per-kind module for the mutation baseline (Stryker upstream, static kernel
 * version). Row shape: `{ path, score, killed, survived }`; higher is better.
 *
 * The rollup score is mutant-weighted (`sum(score * mutants) / sum(mutants)`),
 * so thinly-mutated files cannot drag the aggregate past the floor. Rows carry
 * no timeout/no-coverage counts, so it only approximates Stryker's overall
 * score.
 */

import { canonicalise } from '../path-canon.js';
import { makeBaselineKind } from './kind-factory.js';

export const name = 'mutation';
export const keyField = 'path';

/** Major 2 marks the weighted rollup; older stamps used an unweighted mean. */
const KERNEL_VERSION = '2.0.0';

const WEIGHTED_ROLLUP_MAJOR = 2;

const RESEED_REMEDY =
  'Re-seed the baseline: re-run this project mutation run (Mandrel ships no ' +
  "runner — Stryker is the upstream producer, e.g. 'npx stryker run') so " +
  "'baselines/mutation.json' is rewritten under the weighted rollup, then " +
  "commit it with a 'baseline-refresh:' subject and recalibrate the gate's " +
  'floors against the new number.';

export function projectRow(row) {
  return {
    path: canonicalise(row.path),
    score: Number(row.score),
    killed: Number(row.killed ?? 0),
    survived: Number(row.survived ?? 0),
  };
}

/**
 * @param {unknown} version
 * @returns {number|null} The major, or null when unparseable/absent.
 */
function majorOf(version) {
  const match = /^(\d+)\./.exec(String(version ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Kind-module hook: fail closed on a baseline aggregated by the unweighted
 * mean, whose floors meant a different number. A plain `kernelVersion` drift
 * reaches no exit code, so this hook is the real guard. A missing stamp is
 * rejected too.
 *
 * @param {object|null} baseline A loaded v2 baseline envelope.
 * @returns {string|null} Operator-facing message, or null when compatible.
 */
export function assertBaselineCompatible(baseline) {
  if (!baseline) return null;
  const stamped = baseline.kernelVersion ?? null;
  const major = majorOf(stamped);
  if (major !== null && major >= WEIGHTED_ROLLUP_MAJOR) return null;
  return (
    `[mutation] rollup scoring semantics changed: baseline=${stamped ?? '<unstamped>'} ` +
    `running=${KERNEL_VERSION}. The rollup score is now a mutant-weighted mean ` +
    '(sum(score * mutants) / sum(mutants)) rather than an unweighted mean over ' +
    'files, so the stored aggregate is a different number for the same rows and ' +
    `the floors calibrated against it no longer mean what they did. ${RESEED_REMEDY}`
  );
}

/**
 * @param {object} row
 * @returns {number}
 */
function mutantsOf(row) {
  return (row.killed ?? 0) + (row.survived ?? 0);
}

/**
 * @param {object[]} rows
 * @param {string} field
 * @returns {number}
 */
function sumOf(rows, field) {
  let total = 0;
  for (const r of rows) total += r[field] ?? 0;
  return total;
}

/**
 * Zero mutants yields 0, keeping `NaN` out of the schema-validated envelope.
 *
 * @param {object[]} rows
 * @param {number} mutants Total mutant count across `rows`.
 * @returns {number}
 */
function weightedScore(rows, mutants) {
  if (mutants <= 0) return 0;
  let weighted = 0;
  for (const r of rows) weighted += (r.score ?? 0) * mutantsOf(r);
  return Number((weighted / mutants).toFixed(2));
}

/**
 * @param {object[]} rows
 * @returns {{score: number, killed: number, survived: number, noCoverage: number}}
 */
function aggregate(rows) {
  const scored = rows ?? [];
  const killed = sumOf(scored, 'killed');
  const survived = sumOf(scored, 'survived');
  return {
    score: weightedScore(scored, killed + survived),
    killed,
    survived,
    noCoverage: 0,
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
  kernelVersion: KERNEL_VERSION,
  axes: ['score'],
  betterWhen: 'higher',
  aggregate,
  missingBasePolicy: 'addition',
  removedRowPolicy: {
    kind: 'improvement-when',
    when: (b) => (b.score ?? 0) < 100,
  },
});
