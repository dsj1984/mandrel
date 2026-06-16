// bench/report/compare.js
//
// Cross-run comparison for the Mandrel self-benchmark harness (Epic #4211,
// Story #4218). Internal tooling only — never shipped in the distributed
// `.agents/` bundle, never run against the live repo.
//
// This module surfaces the per-dimension deltas between TWO stored runs — the
// "is the value-add moving over time?" question the persistence ledger
// (bench/report/persist.js) exists to answer. A "run" is a labelled set of
// per-run scorecards (e.g. everything one nightly benchmark execution
// appended). Given a baseline run and a candidate run, for every
// scenario × dimension it reports:
//
//   - the baseline and candidate band centers (per arm: mandrel and control),
//   - the cross-run shift of the Mandrel arm's center (candidate − baseline),
//   - and, reusing the SAME real-delta rule the single-run differential uses
//     (bench/metrics/README.md § Real-delta rule), whether that shift CLEARS
//     the combined run-to-run noise — so a center that wobbled inside the band
//     is reported as "within noise", not a spurious regression/improvement.
//
// It refuses to compare across cohorts: a baseline and candidate stamped with a
// different (model, framework version, env) are NOT like-to-like, and silently
// differencing them would be exactly the apples-to-oranges error the stamp
// exists to prevent. A cohort mismatch is surfaced as a flag, never hidden.
//
// Determinism: pure functions, no I/O, no clock, no randomness. Reads of the
// persisted store live in persist.js; this module operates on the in-memory
// scorecard arrays that reader returns.

import { noiseBand } from '../metrics/variance.js';
import {
  EFFICIENCY_COMPONENTS,
  SCALAR_DIMENSIONS,
} from '../score/differential.js';
import { cohortKey } from './persist.js';

/**
 * All comparable per-run scalars, in render order: the four scalar dimensions
 * plus the efficiency-vector components, each keyed by the metric name the
 * report uses and tagged with its scorecard accessor and "higher is better"
 * polarity (used only to label a shift as improvement vs regression).
 */
const COMPARABLE_METRICS = Object.freeze([
  ...SCALAR_DIMENSIONS.map((d) => ({
    metric: d.name,
    accessor: d.accessor,
    // quality / planningFidelity / autonomy: higher is better.
    // overheadRatio: lower is better.
    higherIsBetter: d.name !== 'overheadRatio',
  })),
  ...EFFICIENCY_COMPONENTS.map((c) => ({
    metric: `efficiency.${c.name}`,
    accessor: c.accessor,
    // Efficiency cost components: lower is better (fewer tokens / ms / $).
    higherIsBetter: false,
  })),
]);

/**
 * Build a noise-band over one run's per-run values for an accessor, or null
 * when no finite values are present. Mirrors the scoring slice's band helper so
 * the comparison's centers/spreads are the identical statistic used elsewhere.
 *
 * @param {Array<object>} scorecards
 * @param {(d: object) => number|null} accessor
 * @param {'iqr'|'ci'} method
 * @returns {import('../metrics/variance.js').NoiseBand|null}
 */
function bandOrNull(scorecards, accessor, method) {
  try {
    return noiseBand(
      scorecards.map((sc) => accessor(sc?.dimensions)),
      { method },
    );
  } catch {
    return null;
  }
}

/**
 * Split a run's scorecards into (scenario → { mandrel, control }) cells.
 *
 * @param {Array<object>} run
 * @returns {Map<string, { mandrel: Array<object>, control: Array<object> }>}
 */
function cellsByScenario(run) {
  const byScenario = new Map();
  for (const sc of run) {
    const scenario = sc?.scenario;
    if (typeof scenario !== 'string') continue;
    if (!byScenario.has(scenario)) {
      byScenario.set(scenario, { mandrel: [], control: [] });
    }
    const cell = byScenario.get(scenario);
    if (sc.arm === 'mandrel') cell.mandrel.push(sc);
    else if (sc.arm === 'control') cell.control.push(sc);
  }
  return byScenario;
}

/**
 * The distinct cohort keys present in a run.
 *
 * @param {Array<object>} run
 * @returns {string[]}
 */
function cohortKeysOf(run) {
  const keys = new Set();
  for (const sc of run) keys.add(cohortKey(sc));
  return [...keys];
}

/**
 * Compare the Mandrel arm's center of one metric between two runs, applying the
 * real-delta rule against the combined run-to-run noise (the larger of the two
 * runs' band spreads — the same `max(spread)` floor the single-run differential
 * uses). Returns a structured verdict.
 *
 * @param {object} args
 * @param {import('../metrics/variance.js').NoiseBand|null} args.baselineBand
 * @param {import('../metrics/variance.js').NoiseBand|null} args.candidateBand
 * @param {boolean} args.higherIsBetter
 * @returns {{
 *   comparable: boolean,
 *   baselineCenter: number|null,
 *   candidateCenter: number|null,
 *   shift: number|null,
 *   noiseFloor: number|null,
 *   shiftIsReal: boolean,
 *   verdict: 'improved'|'regressed'|'within-noise'|'incomparable'
 * }}
 */
function compareCenters({ baselineBand, candidateBand, higherIsBetter }) {
  if (baselineBand === null || candidateBand === null) {
    return {
      comparable: false,
      baselineCenter: baselineBand ? baselineBand.center : null,
      candidateCenter: candidateBand ? candidateBand.center : null,
      shift: null,
      noiseFloor: null,
      shiftIsReal: false,
      verdict: 'incomparable',
    };
  }
  const shift = candidateBand.center - baselineBand.center;
  const noiseFloor = Math.max(baselineBand.spread, candidateBand.spread);
  const shiftIsReal = Math.abs(shift) > noiseFloor;
  let verdict;
  if (!shiftIsReal) {
    verdict = 'within-noise';
  } else {
    const improved = higherIsBetter ? shift > 0 : shift < 0;
    verdict = improved ? 'improved' : 'regressed';
  }
  return {
    comparable: true,
    baselineCenter: baselineBand.center,
    candidateCenter: candidateBand.center,
    shift,
    noiseFloor,
    shiftIsReal,
    verdict,
  };
}

/**
 * Compare two stored runs and surface the per-dimension deltas between them.
 *
 * Both runs are flat scorecard arrays (typically read from the persist store
 * and filtered to one cohort each). For every scenario shared by the two runs
 * and every comparable metric, the result carries the per-arm centers and the
 * Mandrel-arm cross-run shift with its real/within-noise verdict.
 *
 * @param {object} args
 * @param {Array<object>} args.baseline   Baseline run's scorecards (the "from").
 * @param {Array<object>} args.candidate  Candidate run's scorecards (the "to").
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {boolean} [args.requireSameCohort=true]  When true, a cohort mismatch
 *   sets `cohortMatch: false` and still computes the deltas (flagged), so the
 *   caller decides whether to trust them. (We never silently drop the flag.)
 * @returns {{
 *   method: 'iqr'|'ci',
 *   cohortMatch: boolean,
 *   baselineCohorts: string[],
 *   candidateCohorts: string[],
 *   scenarios: Array<{
 *     scenario: string,
 *     inBaseline: boolean,
 *     inCandidate: boolean,
 *     metrics: Array<{
 *       metric: string,
 *       mandrel: ReturnType<typeof compareCenters>,
 *       controlBaselineCenter: number|null,
 *       controlCandidateCenter: number|null
 *     }>
 *   }>
 * }}
 */
export function compareRuns({
  baseline,
  candidate,
  method = 'iqr',
  requireSameCohort = true,
} = {}) {
  if (!Array.isArray(baseline) || !Array.isArray(candidate)) {
    throw new TypeError('compareRuns: baseline and candidate must be arrays');
  }

  const baselineCohorts = cohortKeysOf(baseline);
  const candidateCohorts = cohortKeysOf(candidate);
  // Cohorts match when each run is internally single-cohort AND the two runs
  // share that one cohort.
  const cohortMatch =
    baselineCohorts.length === 1 &&
    candidateCohorts.length === 1 &&
    baselineCohorts[0] === candidateCohorts[0];

  const baseCells = cellsByScenario(baseline);
  const candCells = cellsByScenario(candidate);
  const scenarioNames = new Set([...baseCells.keys(), ...candCells.keys()]);

  const scenarios = [...scenarioNames].sort().map((scenario) => {
    const baseCell = baseCells.get(scenario) ?? { mandrel: [], control: [] };
    const candCell = candCells.get(scenario) ?? { mandrel: [], control: [] };
    const metrics = COMPARABLE_METRICS.map(
      ({ metric, accessor, higherIsBetter }) => {
        const mandrel = compareCenters({
          baselineBand: bandOrNull(baseCell.mandrel, accessor, method),
          candidateBand: bandOrNull(candCell.mandrel, accessor, method),
          higherIsBetter,
        });
        const controlBaseBand = bandOrNull(baseCell.control, accessor, method);
        const controlCandBand = bandOrNull(candCell.control, accessor, method);
        return {
          metric,
          mandrel,
          controlBaselineCenter: controlBaseBand
            ? controlBaseBand.center
            : null,
          controlCandidateCenter: controlCandBand
            ? controlCandBand.center
            : null,
        };
      },
    );
    return {
      scenario,
      inBaseline: baseCells.has(scenario),
      inCandidate: candCells.has(scenario),
      metrics,
    };
  });

  const result = {
    method,
    cohortMatch,
    baselineCohorts,
    candidateCohorts,
    scenarios,
  };

  if (requireSameCohort && !cohortMatch) {
    // Surface the mismatch as a first-class field; the caller / renderer must
    // show it. We do NOT throw — a deliberate cross-cohort diff (e.g. to see a
    // version bump's effect) is a legitimate operator action, but it must be
    // labelled, never silent.
    result.cohortMismatchWarning =
      'Baseline and candidate are not a single shared cohort ' +
      `(baseline: ${baselineCohorts.join(' / ') || 'none'}; ` +
      `candidate: ${candidateCohorts.join(' / ') || 'none'}). ` +
      'Cross-run deltas are not strictly like-to-like.';
  }

  return result;
}

const VERDICT_BADGE = Object.freeze({
  improved: '🟢 improved',
  regressed: '🔴 regressed',
  'within-noise': '≈ within noise',
  incomparable: '— n/a',
});

/**
 * Render a cross-run comparison as a compact Markdown report. Pure.
 *
 * @param {ReturnType<typeof compareRuns>} comparison
 * @param {object} [labels]
 * @param {string} [labels.baselineLabel='baseline']
 * @param {string} [labels.candidateLabel='candidate']
 * @returns {string}  Markdown.
 */
export function renderComparison(
  comparison,
  { baselineLabel = 'baseline', candidateLabel = 'candidate' } = {},
) {
  const fmt = (v, digits = 3) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const rounded = Number(v.toFixed(digits));
    return Object.is(rounded, -0) ? '0' : String(rounded);
  };

  const lines = [
    '# Mandrel Self-Benchmark — Cross-run comparison',
    '',
    `Baseline: **${baselineLabel}** → Candidate: **${candidateLabel}** · band = ${comparison.method}`,
    '',
  ];

  if (comparison.cohortMatch) {
    lines.push(`Cohort: \`${comparison.baselineCohorts[0]}\` (matched).`, '');
  } else {
    lines.push(
      '> ⚠️ **Cohort mismatch.** ' +
        (comparison.cohortMismatchWarning ??
          'Baseline and candidate are not a single shared cohort.'),
      '',
    );
  }

  if (comparison.scenarios.length === 0) {
    lines.push('No shared scenarios to compare.');
    return `${lines.join('\n')}\n`;
  }

  for (const s of comparison.scenarios) {
    lines.push(`## Scenario: \`${s.scenario}\``);
    if (!s.inBaseline || !s.inCandidate) {
      lines.push(
        '',
        `> Present only in ${s.inBaseline ? baselineLabel : candidateLabel}; ` +
          'no cross-run delta computable.',
        '',
      );
    } else {
      lines.push(
        '',
        `| Metric (Mandrel arm) | ${baselineLabel} | ${candidateLabel} | Shift | Noise floor | Verdict |`,
        '| --- | --- | --- | --- | --- | --- |',
      );
      for (const m of s.metrics) {
        const digits = m.metric === 'efficiency.wallClockMs' ? 0 : 3;
        const c = m.mandrel;
        lines.push(
          `| ${m.metric} | ${fmt(c.baselineCenter, digits)} | ${fmt(c.candidateCenter, digits)} | ${fmt(c.shift, digits)} | ${fmt(c.noiseFloor, digits)} | ${VERDICT_BADGE[c.verdict]} |`,
        );
      }
      lines.push('');
    }
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
