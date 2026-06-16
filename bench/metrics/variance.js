// bench/metrics/variance.js
//
// Variance / noise-band method for the Mandrel self-benchmark harness
// (Epic #4211, Story #4215). Internal tooling only — never shipped in the
// distributed `.agents/` bundle.
//
// Every benchmark dimension is reported as a *distribution* across N≈8–10
// runs, never a single point (see Non-Goals in Epic #4211: no composite
// scalar, no point estimates). This module is the single source of truth for
// turning a raw array of per-run dimension values into a noise-band, so the
// scoring and report slices can decide whether a Mandrel-vs-control delta is
// real (clears the band) or indistinguishable from run-to-run noise.
//
// Two band methods are supported, both robust enough for low-N benchmark
// samples:
//
//   - 'iqr'  — median + inter-quartile range (Tukey). The default. Resistant
//              to the heavy-tailed outliers a stalled agent run produces
//              (a single 40-minute wall-clock outlier should not blow out the
//              band). `low`/`high` are the Tukey inner fences
//              (Q1 − 1.5·IQR, Q3 + 1.5·IQR), clamped so the band never
//              extends past the observed min/max.
//   - 'ci'   — mean + 95% confidence interval of the mean, using a Student's
//              t critical value for (n − 1) degrees of freedom. Appropriate
//              when values are roughly symmetric and you want a parametric
//              band on the *mean* rather than a spread descriptor.
//
// Determinism: pure functions, no I/O, no clock, no randomness. The same
// input array always yields the same band, so a persisted scorecard is
// reproducible.

/**
 * @typedef {Object} NoiseBand
 * @property {'iqr' | 'ci'} method      Band method used.
 * @property {number}       n           Number of finite values summarized.
 * @property {number}       center      Point estimate (median for 'iqr',
 *                                       arithmetic mean for 'ci').
 * @property {number}       low         Lower edge of the noise-band.
 * @property {number}       high        Upper edge of the noise-band.
 * @property {number}       spread      Band width (`high - low`), the noise
 *                                       floor a delta must clear to be real.
 * @property {Object}       detail      Method-specific descriptors (see below).
 */

/**
 * Sort a copy of `values` ascending. Never mutates the caller's array.
 *
 * @param {number[]} values
 * @returns {number[]}
 */
function sortedCopy(values) {
  return values.slice().sort((a, b) => a - b);
}

/**
 * Linear-interpolation percentile (the "type 7" / R-default estimator, also
 * what NumPy uses by default). `p` is a fraction in [0, 1].
 *
 * @param {number[]} sorted  Ascending-sorted finite values (length ≥ 1).
 * @param {number}   p       Percentile as a fraction in [0, 1].
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Median of an ascending-sorted array (length ≥ 1).
 *
 * @param {number[]} sorted
 * @returns {number}
 */
function median(sorted) {
  return percentile(sorted, 0.5);
}

/**
 * Arithmetic mean of a finite array (length ≥ 1).
 *
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Sample standard deviation (Bessel-corrected, n − 1 denominator). Returns 0
 * for a single value (no spread is observable from one sample).
 *
 * @param {number[]} values  Finite values (length ≥ 1).
 * @param {number}   m       Precomputed mean of `values`.
 * @returns {number}
 */
function sampleStdDev(values, m) {
  if (values.length < 2) return 0;
  let ss = 0;
  for (const v of values) {
    const d = v - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * Two-sided 95% Student's t critical value for `df` degrees of freedom.
 *
 * Benchmark samples are tiny (N≈8–10 ⇒ df≈7–9), where the normal-approx 1.96
 * understates the interval materially. We use a small lookup table for the
 * common small-df cases and the well-known asymptotic Cornish–Fisher expansion
 * (Abramowitz & Stegun 26.2.23) for larger df, falling back to the normal
 * quantile in the limit. Values match standard t-tables to 2–3 decimals.
 *
 * @param {number} df  Degrees of freedom (n − 1), an integer ≥ 1.
 * @returns {number}   Two-sided 95% (i.e. 0.975 one-sided) t critical value.
 */
function tCritical95(df) {
  // Exact-enough table for the small-sample regime this harness lives in.
  const table = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    11: 2.201,
    12: 2.179,
    13: 2.16,
    14: 2.145,
    15: 2.131,
    16: 2.12,
    17: 2.11,
    18: 2.101,
    19: 2.093,
    20: 2.086,
    25: 2.06,
    30: 2.042,
    40: 2.021,
    60: 2.0,
    120: 1.98,
  };
  if (table[df] !== undefined) return table[df];
  if (df < 1) return Number.POSITIVE_INFINITY;

  // Cornish–Fisher expansion around the normal 0.975 quantile for df not in
  // the table. z = 1.959964 is the standard-normal 97.5th percentile.
  const z = 1.959963984540054;
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3;
}

/**
 * Keep only finite numeric entries. Strings, `null`, `undefined`, `NaN`,
 * `±Infinity`, and non-number types are dropped — the band is computed over
 * the runs that actually produced a value.
 *
 * @param {unknown[]} values
 * @returns {number[]}
 */
function finiteNumbers(values) {
  const out = [];
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Compute a noise-band from an array of per-run dimension values.
 *
 * This is the function the Story's acceptance item names: *"given an array of
 * per-run dimension values, returns a noise-band (e.g. median + IQR or
 * mean + 95% CI)."* Both methods are implemented; `method` selects which.
 *
 * A delta between two arms is only considered **real** when the difference of
 * their centers exceeds the relevant `spread` — that comparison lives in the
 * scoring slice; here we only produce the band.
 *
 * @param {number[]} values            Per-run values for one dimension. Non-
 *                                      finite entries are filtered out first.
 * @param {Object}   [options]
 * @param {'iqr' | 'ci'} [options.method='iqr']  Band method.
 * @returns {NoiseBand}
 * @throws {TypeError}  When `values` is not an array.
 * @throws {RangeError} When no finite values remain, or `method` is unknown.
 */
function noiseBand(values, options = {}) {
  if (!Array.isArray(values)) {
    throw new TypeError(
      `noiseBand: values must be an array, received ${typeof values}`,
    );
  }
  const method = options.method ?? 'iqr';
  if (method !== 'iqr' && method !== 'ci') {
    throw new RangeError(
      `noiseBand: unknown method ${JSON.stringify(method)} (expected 'iqr' or 'ci')`,
    );
  }

  const finite = finiteNumbers(values);
  if (finite.length === 0) {
    throw new RangeError('noiseBand: no finite numeric values to summarize');
  }

  const n = finite.length;
  const min = Math.min(...finite);
  const max = Math.max(...finite);

  if (method === 'ci') {
    const m = mean(finite);
    const sd = sampleStdDev(finite, m);
    // Standard error of the mean; df = n − 1.
    const sem = n > 1 ? sd / Math.sqrt(n) : 0;
    const t = n > 1 ? tCritical95(n - 1) : 0;
    const margin = t * sem;
    return Object.freeze({
      method: 'ci',
      n,
      center: m,
      low: m - margin,
      high: m + margin,
      spread: 2 * margin,
      detail: Object.freeze({
        mean: m,
        stdDev: sd,
        stdError: sem,
        tCritical: t,
        margin,
        confidence: 0.95,
        min,
        max,
      }),
    });
  }

  // method === 'iqr'
  const sorted = sortedCopy(finite);
  const med = median(sorted);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  // Tukey inner fences, clamped to the observed range so the band never
  // claims values that were not observed.
  const fenceLow = Math.max(min, q1 - 1.5 * iqr);
  const fenceHigh = Math.min(max, q3 + 1.5 * iqr);
  return Object.freeze({
    method: 'iqr',
    n,
    center: med,
    low: fenceLow,
    high: fenceHigh,
    spread: fenceHigh - fenceLow,
    detail: Object.freeze({
      median: med,
      q1,
      q3,
      iqr,
      lowerFence: fenceLow,
      upperFence: fenceHigh,
      min,
      max,
    }),
  });
}

export {
  finiteNumbers,
  mean,
  median,
  noiseBand,
  // Exported for reuse by the scoring slice and for unit testing the
  // statistical primitives in isolation.
  percentile,
  sampleStdDev,
  tCritical95,
};
