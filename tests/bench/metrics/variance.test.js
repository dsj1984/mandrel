// tests/bench/metrics/variance.test.js
//
// Unit tier (pure logic, no I/O) for the benchmark noise-band method
// (Epic #4211, Story #4215). Exercises bench/metrics/variance.js: both band
// methods (median+IQR and mean+95%CI), the statistical primitives, input
// filtering, immutability, and error handling.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  finiteNumbers,
  mean,
  median,
  noiseBand,
  percentile,
  sampleStdDev,
  tCritical95,
} from '../../../bench/metrics/variance.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );

describe('variance primitives', () => {
  it('percentile uses linear interpolation (type-7 estimator)', () => {
    const sorted = [1, 2, 3, 4]; // already sorted
    approx(percentile(sorted, 0), 1);
    approx(percentile(sorted, 1), 4);
    approx(percentile(sorted, 0.5), 2.5);
    // rank = 0.25 * 3 = 0.75 → 1 + (2-1)*0.75 = 1.75
    approx(percentile(sorted, 0.25), 1.75);
    // rank = 0.75 * 3 = 2.25 → 3 + (4-3)*0.25 = 3.25
    approx(percentile(sorted, 0.75), 3.25);
  });

  it('percentile of a single value returns that value', () => {
    approx(percentile([42], 0.5), 42);
    approx(percentile([42], 0), 42);
    approx(percentile([42], 1), 42);
  });

  it('median handles odd and even lengths', () => {
    approx(median([1, 2, 3]), 2);
    approx(median([1, 2, 3, 4]), 2.5);
  });

  it('mean is the arithmetic average', () => {
    approx(mean([2, 4, 6]), 4);
    approx(mean([5]), 5);
  });

  it('sampleStdDev is Bessel-corrected and 0 for a single value', () => {
    // values [2,4,4,4,5,5,7,9], known sample sd = 2.13808...
    const vals = [2, 4, 4, 4, 5, 5, 7, 9];
    const m = mean(vals);
    approx(sampleStdDev(vals, m), 2.138089935299395, 1e-9);
    approx(sampleStdDev([5], 5), 0);
  });

  it('tCritical95 matches standard t-table values', () => {
    approx(tCritical95(1), 12.706, 1e-3);
    approx(tCritical95(7), 2.365, 1e-3);
    approx(tCritical95(9), 2.262, 1e-3);
    approx(tCritical95(30), 2.042, 1e-3);
  });

  it('tCritical95 falls back to the asymptotic expansion off-table', () => {
    // df=50 is not in the table; should sit between the df=40 and df=60
    // table entries (2.021 and 2.000) and near the true ~2.009.
    const t50 = tCritical95(50);
    assert.ok(t50 < 2.021 && t50 > 2.0, `t(50)=${t50} should be ~2.009`);
    approx(t50, 2.009, 5e-3);
  });

  it('finiteNumbers drops non-finite and non-number entries', () => {
    const input = [
      1,
      '2',
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      3.5,
      0,
    ];
    assert.deepEqual(finiteNumbers(input), [1, 3.5, 0]);
  });
});

describe('noiseBand — iqr (default)', () => {
  it('defaults to the iqr method', () => {
    const band = noiseBand([1, 2, 3, 4, 5]);
    assert.equal(band.method, 'iqr');
  });

  it('reports median center, quartiles, and clamped Tukey fences', () => {
    const values = [10, 12, 14, 16, 18, 20, 22, 24];
    const band = noiseBand(values, { method: 'iqr' });
    assert.equal(band.n, 8);
    approx(band.center, 17); // median of 8 symmetric values
    // Q1 (p=.25, rank=1.75) = 12 + (14-12)*.75 = 13.5
    // Q3 (p=.75, rank=5.25) = 20 + (22-20)*.25 = 20.5
    approx(band.detail.q1, 13.5);
    approx(band.detail.q3, 20.5);
    approx(band.detail.iqr, 7);
    // fences: Q1-1.5*7 = 3 (clamp to min 10), Q3+1.5*7 = 31 (clamp to max 24)
    approx(band.low, 10);
    approx(band.high, 24);
    approx(band.spread, 14);
    approx(band.detail.min, 10);
    approx(band.detail.max, 24);
  });

  it('does not clamp when an outlier pushes a fence past the inner quartiles but within range', () => {
    // tightly clustered with one high outlier; the upper fence stays below
    // the outlier so it is flagged as out-of-band.
    const values = [10, 10, 11, 11, 12, 12, 13, 100];
    const band = noiseBand(values, { method: 'iqr' });
    assert.ok(
      band.high < 100,
      `upper fence ${band.high} should exclude the 100 outlier`,
    );
    assert.ok(band.center >= 10 && band.center <= 13);
  });

  it('handles a single value with a zero-width band', () => {
    const band = noiseBand([7]);
    assert.equal(band.n, 1);
    approx(band.center, 7);
    approx(band.low, 7);
    approx(band.high, 7);
    approx(band.spread, 0);
  });

  it('filters non-finite values before computing', () => {
    const band = noiseBand([5, Number.NaN, '99', null, 5, 5]);
    assert.equal(band.n, 3);
    approx(band.center, 5);
    approx(band.spread, 0);
  });
});

describe('noiseBand — ci', () => {
  it('reports mean center and a symmetric t-based interval', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const band = noiseBand(values, { method: 'ci' });
    assert.equal(band.method, 'ci');
    assert.equal(band.n, 8);
    approx(band.center, 5); // mean
    approx(band.detail.mean, 5);
    approx(band.detail.stdDev, 2.138089935299395, 1e-9);
    // sem = sd/sqrt(8) = 0.755928...; t(7)=2.365; margin = 1.78777...
    approx(band.detail.stdError, 0.7559289460184544, 1e-9);
    approx(band.detail.tCritical, 2.365, 1e-3);
    approx(band.detail.margin, 1.78777, 1e-3);
    approx(band.low, 5 - 1.78777, 1e-3);
    approx(band.high, 5 + 1.78777, 1e-3);
    approx(band.spread, 2 * 1.78777, 1e-3);
    assert.equal(band.detail.confidence, 0.95);
  });

  it('is symmetric about the mean', () => {
    const band = noiseBand([10, 20, 30, 40, 50], { method: 'ci' });
    approx(band.center, 30);
    approx((band.low + band.high) / 2, band.center, 1e-9);
  });

  it('yields a zero-width band for a single value', () => {
    const band = noiseBand([42], { method: 'ci' });
    assert.equal(band.n, 1);
    approx(band.center, 42);
    approx(band.spread, 0);
    approx(band.detail.stdError, 0);
    approx(band.detail.tCritical, 0);
  });
});

describe('noiseBand — immutability and contract', () => {
  it('never mutates the caller array', () => {
    const values = [5, 3, 1, 4, 2];
    const snapshot = values.slice();
    noiseBand(values, { method: 'iqr' });
    noiseBand(values, { method: 'ci' });
    assert.deepEqual(values, snapshot);
  });

  it('returns a frozen band object', () => {
    const band = noiseBand([1, 2, 3]);
    assert.ok(Object.isFrozen(band));
    assert.ok(Object.isFrozen(band.detail));
  });

  it('always reports low <= center <= high', () => {
    for (const method of ['iqr', 'ci']) {
      const band = noiseBand([3, 1, 9, 4, 2, 8, 5], { method });
      assert.ok(
        band.low <= band.center && band.center <= band.high,
        `${method}: ${band.low} <= ${band.center} <= ${band.high}`,
      );
      approx(band.spread, band.high - band.low, 1e-9);
    }
  });
});

describe('noiseBand — error handling', () => {
  it('throws TypeError when values is not an array', () => {
    assert.throws(() => noiseBand('nope'), TypeError);
    assert.throws(() => noiseBand(undefined), TypeError);
    assert.throws(() => noiseBand({ length: 3 }), TypeError);
  });

  it('throws RangeError when no finite values remain', () => {
    assert.throws(() => noiseBand([]), RangeError);
    assert.throws(
      () => noiseBand([Number.NaN, '1', null, Number.POSITIVE_INFINITY]),
      RangeError,
    );
  });

  it('throws RangeError on an unknown method', () => {
    assert.throws(() => noiseBand([1, 2, 3], { method: 'stddev' }), RangeError);
  });
});
