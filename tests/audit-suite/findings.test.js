import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateBaselineDelta,
  aggregateSummary,
} from '../../.agents/scripts/lib/audit-suite/findings.js';

test('aggregateSummary: empty input yields a zero histogram', () => {
  assert.deepEqual(aggregateSummary([]), {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  });
});

test('aggregateSummary: nullish input is tolerated', () => {
  assert.deepEqual(aggregateSummary(null), {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  });
  assert.deepEqual(aggregateSummary(undefined), {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  });
});

test('aggregateSummary: counts each known severity correctly', () => {
  const result = aggregateSummary([
    { severity: 'critical' },
    { severity: 'high' },
    { severity: 'high' },
    { severity: 'medium' },
    { severity: 'low' },
    { severity: 'low' },
    { severity: 'low' },
  ]);
  assert.deepEqual(result, { critical: 1, high: 2, medium: 1, low: 3 });
});

test('aggregateSummary: silently ignores unknown severities', () => {
  const result = aggregateSummary([
    { severity: 'high' },
    { severity: 'sev1' },
    { severity: 'info' },
    { severity: '' },
  ]);
  assert.deepEqual(result, { critical: 0, high: 1, medium: 0, low: 0 });
});

// ---------------------------------------------------------------------------
// aggregateBaselineDelta — Task #1920 (per-component rollup deltas)
// ---------------------------------------------------------------------------

test('aggregateBaselineDelta: unchanged baselines produce empty delta', () => {
  const env = { rollup: { '*': { lines: 90, branches: 80 } }, rows: [] };
  const delta = aggregateBaselineDelta({ before: env, after: env });
  assert.deepEqual(delta, []);
});

test('aggregateBaselineDelta: surfaces a single-axis regression on `*`', () => {
  const before = { rollup: { '*': { lines: 90, branches: 80 } } };
  const after = { rollup: { '*': { lines: 85, branches: 80 } } };
  const delta = aggregateBaselineDelta({ before, after });
  assert.deepEqual(delta, [
    {
      component: '*',
      axes: [{ axis: 'lines', before: 90, after: 85, delta: -5 }],
    },
  ]);
});

test('aggregateBaselineDelta: stable order — `*` first, then alpha', () => {
  const before = {
    rollup: {
      '*': { lines: 90 },
      worker: { lines: 88 },
      api: { lines: 92 },
    },
  };
  const after = {
    rollup: {
      '*': { lines: 89 },
      worker: { lines: 87 },
      api: { lines: 91 },
    },
  };
  const delta = aggregateBaselineDelta({ before, after });
  assert.deepEqual(
    delta.map((e) => e.component),
    ['*', 'api', 'worker'],
  );
});

test('aggregateBaselineDelta: regression in one component does not pollute others', () => {
  const before = {
    rollup: {
      '*': { lines: 90 },
      api: { lines: 92 },
      worker: { lines: 88 },
    },
  };
  const after = {
    rollup: {
      '*': { lines: 90 },
      api: { lines: 80 }, // regressed
      worker: { lines: 88 }, // unchanged
    },
  };
  const delta = aggregateBaselineDelta({ before, after });
  assert.equal(delta.length, 1);
  assert.equal(delta[0].component, 'api');
});

test('aggregateBaselineDelta: includes appeared/disappeared axes with null sides', () => {
  const before = { rollup: { '*': { lines: 90 } } };
  const after = { rollup: { '*': { lines: 90, branches: 80 } } };
  const delta = aggregateBaselineDelta({ before, after });
  assert.deepEqual(delta, [
    {
      component: '*',
      axes: [{ axis: 'branches', before: null, after: 80, delta: null }],
    },
  ]);
});

test('aggregateBaselineDelta: nullish envelopes are tolerated as empty', () => {
  assert.deepEqual(aggregateBaselineDelta({}), []);
  assert.deepEqual(aggregateBaselineDelta({ before: null, after: null }), []);
});
