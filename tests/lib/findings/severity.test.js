/**
 * Unit tests for lib/findings/severity.js — the canonical severity vocabulary
 * shared by `classify-finding.js` and `promote-finding.js` (Story #3816).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SEVERITY,
  highestSeverity,
  normalizeSeverity,
  SEVERITIES,
  SEVERITY_RANK,
} from '../../../.agents/scripts/lib/findings/severity.js';

test('SEVERITIES is the canonical schema order, highest → lowest', () => {
  assert.deepEqual(SEVERITIES, ['critical', 'high', 'medium', 'low', 'info']);
});

test('SEVERITIES is frozen (single source of truth cannot be mutated)', () => {
  assert.ok(Object.isFrozen(SEVERITIES));
  assert.throws(() => {
    SEVERITIES.push('catastrophic');
  });
});

test('DEFAULT_SEVERITY is the canonical floor', () => {
  assert.equal(DEFAULT_SEVERITY, 'info');
  assert.ok(SEVERITIES.includes(DEFAULT_SEVERITY));
});

test('SEVERITY_RANK ranks critical highest and info lowest, derived from order', () => {
  assert.equal(SEVERITY_RANK.critical, 4);
  assert.equal(SEVERITY_RANK.high, 3);
  assert.equal(SEVERITY_RANK.medium, 2);
  assert.equal(SEVERITY_RANK.low, 1);
  assert.equal(SEVERITY_RANK.info, 0);
  // Strictly monotonic across the canonical order.
  for (let i = 1; i < SEVERITIES.length; i += 1) {
    assert.ok(SEVERITY_RANK[SEVERITIES[i - 1]] > SEVERITY_RANK[SEVERITIES[i]]);
  }
});

test('normalizeSeverity returns each canonical value unchanged', () => {
  for (const severity of SEVERITIES) {
    assert.equal(normalizeSeverity(severity), severity);
  }
});

test('normalizeSeverity is case- and whitespace-insensitive', () => {
  assert.equal(normalizeSeverity('  High '), 'high');
  assert.equal(normalizeSeverity('CRITICAL'), 'critical');
});

test('normalizeSeverity falls back to the canonical floor for unusable input', () => {
  assert.equal(normalizeSeverity(undefined), 'info');
  assert.equal(normalizeSeverity(null), 'info');
  assert.equal(normalizeSeverity(42), 'info');
  assert.equal(normalizeSeverity(''), 'info');
  assert.equal(normalizeSeverity('bogus'), 'info');
});

test('normalizeSeverity honours an explicit fallback', () => {
  assert.equal(normalizeSeverity(undefined, 'critical'), 'critical');
  assert.equal(normalizeSeverity('bogus', 'low'), 'low');
  // A recognised value still wins over the fallback.
  assert.equal(normalizeSeverity('medium', 'low'), 'medium');
});

test('highestSeverity returns the highest-ranked value in a list', () => {
  assert.equal(highestSeverity(['low', 'critical', 'medium']), 'critical');
  assert.equal(highestSeverity(['info', 'low']), 'low');
});

test('highestSeverity normalises members and defaults an empty list', () => {
  assert.equal(highestSeverity([]), 'info');
  assert.equal(highestSeverity(['  High ', 'bogus', undefined]), 'high');
});
