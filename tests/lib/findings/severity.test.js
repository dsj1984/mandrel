/**
 * Unit tests for lib/findings/severity.js — the canonical severity vocabulary
 * shared by `classify-finding.js` and `promote-finding.js` (Story #3816).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __testing,
  fingerprintSeverity,
  highestSeverity,
  normalizeSeverity,
  SEVERITIES,
  SEVERITY_RANK,
  sortBySeverity,
} from '../../../.agents/scripts/lib/findings/severity.js';

// Module internals: consumed only by this module's own exported functions, so
// they are reached through `__testing` rather than widening the public surface.
const { DEFAULT_SEVERITY, SEVERITY_ALIASES } = __testing;

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

// ---------------------------------------------------------------------------
// Story #4877 — the alias table and the fingerprint projection.
// ---------------------------------------------------------------------------

test('SEVERITY_ALIASES never shadows a canonical level', () => {
  for (const alias of Object.keys(SEVERITY_ALIASES)) {
    assert.ok(
      !SEVERITIES.includes(alias),
      `"${alias}" is a canonical level, so it must not also be an alias`,
    );
  }
  for (const target of Object.values(SEVERITY_ALIASES)) {
    assert.ok(
      SEVERITIES.includes(target),
      `alias target "${target}" is not a canonical level`,
    );
  }
});

test('normalizeSeverity resolves the alias spellings lenses actually write', () => {
  assert.equal(normalizeSeverity('Informational'), 'info');
  assert.equal(normalizeSeverity('  MODERATE '), 'medium');
  assert.equal(normalizeSeverity('Blocker'), 'critical');
  assert.equal(normalizeSeverity('major'), 'high');
  assert.equal(normalizeSeverity('minor'), 'low');
  assert.equal(normalizeSeverity('nit'), 'info');
});

test('normalizeSeverity still honours an explicit fallback for an unknown alias', () => {
  assert.equal(normalizeSeverity('spicy', null), null);
});

test('fingerprintSeverity keeps an absent severity as the empty string', () => {
  // The pipeline normaliser resolves absent → `info`. The identity projection
  // must NOT: folding `info` in where the previous raw implementation folded
  // '' would re-mint the fingerprint of every severity-less finding already
  // filed, silently breaking dedup for all of them.
  assert.equal(normalizeSeverity(undefined), 'info');
  for (const absent of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(
      fingerprintSeverity(absent),
      '',
      `${JSON.stringify(absent)} must project to the empty string`,
    );
  }
});

test('fingerprintSeverity passes an unrecognised value through verbatim', () => {
  // Collapsing it onto `info` would move the sha of any finding already filed
  // with an off-vocabulary severity.
  assert.equal(fingerprintSeverity('spicy'), 'spicy');
  assert.equal(fingerprintSeverity('  Spicy  '), 'spicy');
});

test('fingerprintSeverity is idempotent under normalizeSeverity (the invariance the fingerprint needs)', () => {
  const raws = [
    'critical',
    'High',
    'medium',
    'LOW',
    'info',
    'Informational',
    'moderate',
    'blocker',
    'major',
    'minor',
  ];
  for (const raw of raws) {
    assert.equal(
      fingerprintSeverity(raw),
      fingerprintSeverity(normalizeSeverity(raw)),
      `"${raw}" must project the same before and after normalisation`,
    );
  }
});

test('fingerprintSeverity returns a canonical level for every canonical input', () => {
  for (const level of SEVERITIES) {
    assert.equal(fingerprintSeverity(level), level);
  }
});

test('sortBySeverity orders highest first, stably, with an unresolvable severity last', () => {
  const items = [
    { id: 'low', severity: 'low' },
    { id: 'none', severity: null },
    { id: 'crit', severity: 'critical' },
    { id: 'low-2', severity: 'low' },
  ];
  assert.deepEqual(
    sortBySeverity(items).map((i) => i.id),
    ['crit', 'low', 'low-2', 'none'],
  );
  assert.equal(items[0].id, 'low', 'the input array is not mutated');
});
