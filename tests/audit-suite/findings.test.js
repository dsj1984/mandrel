import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateSummary } from '../../.agents/scripts/lib/audit-suite/findings.js';

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
