// bench/score/differential.js
//
// The Mandrel-vs-control differential + cross-scenario calibration metrics for
// the Mandrel self-benchmark harness (Epic #4211, Story #4217). Internal
// tooling only — never shipped in the distributed `.agents/` bundle.
//
// This module sits on top of the per-run scorecards (bench/collect/normalize.js)
// and the noise-band primitive (bench/metrics/variance.js). It computes:
//
//   1. The per-dimension Mandrel-vs-control delta across the N runs of one
//      (scenario) cell, with the binding "real-delta" rule from
//      bench/metrics/README.md § "Real-delta rule":
//
//        deltaIsReal = |centerMandrel − centerControl|
//                        > max(spreadMandrel, spreadControl)
//
//      A delta that does not clear the larger of the two arms' noise-band
//      spreads is reported as "within noise" (no significant difference).
//
//   2. The two cross-scenario derived metrics (README § "Cross-scenario
//      derived metrics") — computed by comparing scenarios, never scored
//      per-run:
//        A. Difficulty monotonicity — Efficiency must RISE and Overhead ratio
//           must FALL as difficulty increases; a violation is a calibration
//           warning, surfaced explicitly.
//        B. Overhead floor — the fixed ceremony tax Mandrel pays above control
//           on the near-zero `hello-world` rung, with its own band over the
//           per-run differences.
//
// Determinism: pure functions, no I/O, no clock, no randomness.

import { noiseBand } from '../metrics/variance.js';

/**
 * The five scorecard dimensions, in canonical order, each tagged with the
 * single per-run scalar that represents it for differential purposes.
 * `quality`, `planningFidelity`, `autonomy` and `overheadRatio` each have a
 * natural headline scalar. `efficiency` is a vector (README § 4 — "never
 * collapsed to one number"), so it is differenced per-component rather than as
 * a single dimension; see `EFFICIENCY_COMPONENTS`.
 *
 * The accessor pulls the scalar out of a scorecard's `dimensions.<name>`
 * sub-object, returning `null` when the value is null (e.g. planningFidelity on
 * the control arm) so it is filtered out of the band by `noiseBand`.
 */
export const SCALAR_DIMENSIONS = Object.freeze([
  { name: 'quality', accessor: (d) => d?.quality?.score ?? null },
  {
    name: 'planningFidelity',
    accessor: (d) => d?.planningFidelity?.score ?? null,
  },
  { name: 'autonomy', accessor: (d) => d?.autonomy?.score ?? null },
  {
    name: 'overheadRatio',
    accessor: (d) => d?.overheadRatio?.tokenRatio ?? null,
  },
]);

/**
 * The Efficiency vector components, each differenced independently (each gets
 * its own distribution + band, per README § 4).
 */
export const EFFICIENCY_COMPONENTS = Object.freeze([
  { name: 'wallClockMs', accessor: (d) => d?.efficiency?.wallClockMs ?? null },
  { name: 'totalTokens', accessor: (d) => d?.efficiency?.totalTokens ?? null },
  { name: 'dispatches', accessor: (d) => d?.efficiency?.dispatches ?? null },
  { name: 'costUsd', accessor: (d) => d?.efficiency?.costUsd ?? null },
]);

/**
 * Pull the per-run scalar values for one (dimension accessor) across a set of
 * scorecards. Non-finite / null entries are left in place; `noiseBand` filters
 * them, so a metric that is null for one arm (planningFidelity on control)
 * simply yields an empty band.
 *
 * @param {Array<object>} scorecards
 * @param {(dimensions: object) => number|null} accessor
 * @returns {Array<number|null>}
 */
function valuesFor(scorecards, accessor) {
  return scorecards.map((sc) => accessor(sc?.dimensions));
}

/**
 * Compute a noise-band, or `null` when no finite values are present (so a
 * dimension that is null for an arm — planningFidelity on control — does not
 * throw, it simply has no band).
 *
 * @param {Array<number|null>} values
 * @param {'iqr'|'ci'} method
 * @returns {import('../metrics/variance.js').NoiseBand|null}
 */
function bandOrNull(values, method) {
  try {
    return noiseBand(values, { method });
  } catch {
    // RangeError: no finite values to summarize.
    return null;
  }
}

/**
 * Apply the binding real-delta rule to two arms' bands for one metric.
 *
 *   deltaIsReal = |centerMandrel − centerControl| > max(spreadMandrel, spreadControl)
 *
 * When either band is null (the metric was null for that arm across all its
 * runs — e.g. planningFidelity on control), the delta cannot be computed and
 * is reported with `deltaIsReal: false` and `comparable: false`.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {import('../metrics/variance.js').NoiseBand|null} args.mandrelBand
 * @param {import('../metrics/variance.js').NoiseBand|null} args.controlBand
 * @returns {{
 *   metric: string,
 *   comparable: boolean,
 *   mandrelCenter: number|null,
 *   controlCenter: number|null,
 *   delta: number|null,
 *   noiseFloor: number|null,
 *   deltaIsReal: boolean,
 *   verdict: 'real'|'within-noise'|'incomparable',
 *   mandrelBand: object|null,
 *   controlBand: object|null
 * }}
 */
function compareBands({ name, mandrelBand, controlBand }) {
  if (mandrelBand === null || controlBand === null) {
    return {
      metric: name,
      comparable: false,
      mandrelCenter: mandrelBand ? mandrelBand.center : null,
      controlCenter: controlBand ? controlBand.center : null,
      delta: null,
      noiseFloor: null,
      deltaIsReal: false,
      verdict: 'incomparable',
      mandrelBand,
      controlBand,
    };
  }
  const delta = mandrelBand.center - controlBand.center;
  const noiseFloor = Math.max(mandrelBand.spread, controlBand.spread);
  const deltaIsReal = Math.abs(delta) > noiseFloor;
  return {
    metric: name,
    comparable: true,
    mandrelCenter: mandrelBand.center,
    controlCenter: controlBand.center,
    delta,
    noiseFloor,
    deltaIsReal,
    verdict: deltaIsReal ? 'real' : 'within-noise',
    mandrelBand,
    controlBand,
  };
}

/**
 * Compute the full Mandrel-vs-control differential for ONE scenario cell.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns  Scorecards for the Mandrel arm.
 * @param {Array<object>} args.controlRuns  Scorecards for the control arm.
 * @param {'iqr'|'ci'} [args.method='iqr']  Band method passed to noiseBand.
 * @param {string} [args.scenario]          Optional scenario id for labelling.
 * @returns {{
 *   scenario: string|undefined,
 *   method: 'iqr'|'ci',
 *   n: { mandrel: number, control: number },
 *   dimensions: Record<string, object>,
 *   efficiency: Record<string, object>
 * }}
 */
export function computeDifferential({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  scenario,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'computeDifferential: mandrelRuns and controlRuns must be arrays',
    );
  }

  const dimensions = {};
  for (const { name, accessor } of SCALAR_DIMENSIONS) {
    const mandrelBand = bandOrNull(valuesFor(mandrelRuns, accessor), method);
    const controlBand = bandOrNull(valuesFor(controlRuns, accessor), method);
    dimensions[name] = compareBands({ name, mandrelBand, controlBand });
  }

  const efficiency = {};
  for (const { name, accessor } of EFFICIENCY_COMPONENTS) {
    const mandrelBand = bandOrNull(valuesFor(mandrelRuns, accessor), method);
    const controlBand = bandOrNull(valuesFor(controlRuns, accessor), method);
    efficiency[name] = compareBands({
      name: `efficiency.${name}`,
      mandrelBand,
      controlBand,
    });
  }

  return {
    scenario,
    method,
    n: { mandrel: mandrelRuns.length, control: controlRuns.length },
    dimensions,
    efficiency,
  };
}

/**
 * Center of a band over the Mandrel arm's per-run values for one metric in one
 * scenario cell — the building block of the cross-scenario metrics. Returns
 * `null` when the cell has no finite values.
 *
 * @param {Array<object>} scorecards
 * @param {(d: object) => number|null} accessor
 * @param {'iqr'|'ci'} method
 * @returns {number|null}
 */
function centerOf(scorecards, accessor, method) {
  const band = bandOrNull(valuesFor(scorecards, accessor), method);
  return band ? band.center : null;
}

/**
 * Cross-scenario metric A — **difficulty monotonicity** (calibration guardrail).
 *
 * Over the difficulty-ordered scenario list (easy → hard), comparing the
 * Mandrel arm's band centers, two things MUST hold for every adjacent pair:
 *
 *   - Efficiency (totalTokens) RISES:   center(tokens, sᵢ) < center(tokens, sᵢ₊₁)
 *   - Overhead ratio FALLS:             center(ratio,  sᵢ) > center(ratio,  sᵢ₊₁)
 *
 * A violation is a **calibration warning**, surfaced explicitly (never a silent
 * pass): it means the instrument is insensitive or a scenario is mis-graded.
 *
 * @param {object} args
 * @param {Array<{ scenario: string, difficulty: number, mandrelRuns: Array<object> }>} args.cells
 *   One entry per scenario, each carrying the scenario id, its numeric
 *   difficulty (from scenario.json), and the Mandrel arm's scorecards.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @returns {{
 *   ordered: Array<{ scenario: string, difficulty: number, totalTokens: number|null, tokenRatio: number|null }>,
 *   pairs: Array<{
 *     from: string, to: string,
 *     efficiencyRises: boolean, overheadFalls: boolean,
 *     holds: boolean,
 *     violations: string[]
 *   }>,
 *   monotonicityHolds: boolean,
 *   warnings: string[]
 * }}
 */
export function difficultyMonotonicity({ cells, method = 'iqr' }) {
  if (!Array.isArray(cells)) {
    throw new TypeError('difficultyMonotonicity: cells must be an array');
  }

  const ordered = cells
    .map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      totalTokens: centerOf(
        c.mandrelRuns ?? [],
        (d) => d?.efficiency?.totalTokens ?? null,
        method,
      ),
      tokenRatio: centerOf(
        c.mandrelRuns ?? [],
        (d) => d?.overheadRatio?.tokenRatio ?? null,
        method,
      ),
    }))
    .sort((a, b) => a.difficulty - b.difficulty);

  const pairs = [];
  const warnings = [];
  let monotonicityHolds = true;

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const lo = ordered[i];
    const hi = ordered[i + 1];
    const violations = [];

    // Efficiency must rise (harder work costs more in absolute terms).
    const efficiencyRises =
      lo.totalTokens !== null &&
      hi.totalTokens !== null &&
      hi.totalTokens > lo.totalTokens;
    if (lo.totalTokens === null || hi.totalTokens === null) {
      violations.push(
        `efficiency.totalTokens not comparable between ${lo.scenario} and ${hi.scenario} (missing band center)`,
      );
    } else if (!efficiencyRises) {
      violations.push(
        `efficiency.totalTokens did not rise: ${lo.scenario}=${lo.totalTokens} ≥ ${hi.scenario}=${hi.totalTokens}`,
      );
    }

    // Overhead ratio must fall (ceremony amortizes over more output).
    const overheadFalls =
      lo.tokenRatio !== null &&
      hi.tokenRatio !== null &&
      hi.tokenRatio < lo.tokenRatio;
    if (lo.tokenRatio === null || hi.tokenRatio === null) {
      violations.push(
        `overheadRatio.tokenRatio not comparable between ${lo.scenario} and ${hi.scenario} (missing band center)`,
      );
    } else if (!overheadFalls) {
      violations.push(
        `overheadRatio.tokenRatio did not fall: ${lo.scenario}=${lo.tokenRatio} ≤ ${hi.scenario}=${hi.tokenRatio}`,
      );
    }

    const holds = violations.length === 0;
    if (!holds) {
      monotonicityHolds = false;
      for (const v of violations) {
        warnings.push(`[calibration] ${v}`);
      }
    }
    pairs.push({
      from: lo.scenario,
      to: hi.scenario,
      efficiencyRises,
      overheadFalls,
      holds,
      violations,
    });
  }

  return { ordered, pairs, monotonicityHolds, warnings };
}

/**
 * Cross-scenario metric B — **overhead floor** (framework finding).
 *
 * The fixed ceremony tax Mandrel pays on near-zero work, estimated from the
 * `hello-world` rung as the cost the Mandrel arm pays ABOVE the control arm:
 *
 *   overheadFloorTokens = center(totalTokens, hello-world, mandrel)
 *                        − center(totalTokens, hello-world, control)
 *   overheadFloorUsd    = center(costUsd,     hello-world, mandrel)
 *                        − center(costUsd,     hello-world, control)
 *
 * Computed on the band centers (so it inherits the distribution method) AND
 * reported with its own band derived from the per-run differences (paired
 * across the run index, which is what the README's "reported with its own band
 * derived from the per-run differences" calls for).
 *
 * A large floor with NO corresponding `quality.score` gain on `hello-world` is
 * the canonical evidence for the report's "ceremony-lite path for trivial
 * scopes" recommendation; this function surfaces that condition as a flag.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns  hello-world Mandrel scorecards.
 * @param {Array<object>} args.controlRuns  hello-world control scorecards.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {number} [args.qualityGainEpsilon=0.05]  A Mandrel quality center
 *   that exceeds control by less than this is treated as "no quality gain".
 * @returns {{
 *   scenario: 'hello-world',
 *   overheadFloorTokens: number|null,
 *   overheadFloorUsd: number|null,
 *   tokenDiffBand: object|null,
 *   usdDiffBand: object|null,
 *   qualityGain: number|null,
 *   noQualityGain: boolean,
 *   recommendCeremonyLite: boolean
 * }}
 */
export function overheadFloor({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  qualityGainEpsilon = 0.05,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'overheadFloor: mandrelRuns and controlRuns must be arrays',
    );
  }

  const tokenAccessor = (d) => d?.efficiency?.totalTokens ?? null;
  const usdAccessor = (d) => d?.efficiency?.costUsd ?? null;
  const qualityAccessor = (d) => d?.quality?.score ?? null;

  const mandrelTokens = centerOf(mandrelRuns, tokenAccessor, method);
  const controlTokens = centerOf(controlRuns, tokenAccessor, method);
  const overheadFloorTokens =
    mandrelTokens !== null && controlTokens !== null
      ? mandrelTokens - controlTokens
      : null;

  const mandrelUsd = centerOf(mandrelRuns, usdAccessor, method);
  const controlUsd = centerOf(controlRuns, usdAccessor, method);
  const overheadFloorUsd =
    mandrelUsd !== null && controlUsd !== null ? mandrelUsd - controlUsd : null;

  // Per-run paired differences (index-aligned over the shorter arm) give the
  // floor its own band.
  const pairCount = Math.min(mandrelRuns.length, controlRuns.length);
  const tokenDiffs = [];
  const usdDiffs = [];
  for (let i = 0; i < pairCount; i += 1) {
    const mt = tokenAccessor(mandrelRuns[i]?.dimensions);
    const ct = tokenAccessor(controlRuns[i]?.dimensions);
    if (typeof mt === 'number' && typeof ct === 'number') {
      tokenDiffs.push(mt - ct);
    }
    const mu = usdAccessor(mandrelRuns[i]?.dimensions);
    const cu = usdAccessor(controlRuns[i]?.dimensions);
    if (typeof mu === 'number' && typeof cu === 'number') {
      usdDiffs.push(mu - cu);
    }
  }
  const tokenDiffBand = bandOrNull(tokenDiffs, method);
  const usdDiffBand = bandOrNull(usdDiffs, method);

  const mandrelQuality = centerOf(mandrelRuns, qualityAccessor, method);
  const controlQuality = centerOf(controlRuns, qualityAccessor, method);
  const qualityGain =
    mandrelQuality !== null && controlQuality !== null
      ? mandrelQuality - controlQuality
      : null;
  const noQualityGain =
    qualityGain !== null && qualityGain < qualityGainEpsilon;

  // The recommendation fires when there IS a positive overhead floor AND no
  // matching quality gain to justify it.
  const recommendCeremonyLite =
    overheadFloorTokens !== null && overheadFloorTokens > 0 && noQualityGain;

  return {
    scenario: 'hello-world',
    overheadFloorTokens,
    overheadFloorUsd,
    tokenDiffBand,
    usdDiffBand,
    qualityGain,
    noQualityGain,
    recommendCeremonyLite,
  };
}

/**
 * Convenience top-level: compute the per-scenario differentials AND both
 * cross-scenario metrics from a full corpus of scorecards keyed by scenario
 * and arm. This is the function a report slice calls with everything it has.
 *
 * @param {object} args
 * @param {Array<{
 *   scenario: string,
 *   difficulty: number,
 *   mandrelRuns: Array<object>,
 *   controlRuns: Array<object>
 * }>} args.cells
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @returns {{
 *   method: 'iqr'|'ci',
 *   perScenario: Array<ReturnType<typeof computeDifferential>>,
 *   difficultyMonotonicity: ReturnType<typeof difficultyMonotonicity>,
 *   overheadFloor: ReturnType<typeof overheadFloor>|null
 * }}
 */
export function scoreCorpus({ cells, method = 'iqr' }) {
  if (!Array.isArray(cells)) {
    throw new TypeError('scoreCorpus: cells must be an array');
  }

  const perScenario = cells.map((c) =>
    computeDifferential({
      scenario: c.scenario,
      mandrelRuns: c.mandrelRuns ?? [],
      controlRuns: c.controlRuns ?? [],
      method,
    }),
  );

  const mono = difficultyMonotonicity({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns ?? [],
    })),
    method,
  });

  const floorCell = cells.find((c) => c.scenario === 'hello-world');
  const floor = floorCell
    ? overheadFloor({
        mandrelRuns: floorCell.mandrelRuns ?? [],
        controlRuns: floorCell.controlRuns ?? [],
        method,
      })
    : null;

  return {
    method,
    perScenario,
    difficultyMonotonicity: mono,
    overheadFloor: floor,
  };
}
