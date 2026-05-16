import assert from 'node:assert';
import { test } from 'node:test';
import {
  resolveCrapEnvOverrides,
  resolveMaintainabilityEnvOverrides,
} from '../.agents/scripts/lib/baselines/env-overrides.js';

/**
 * Tests for the env-var override helpers. Originally added for the
 * (since-removed) baseline-refresh CI guardrail; retained because the
 * env-var overrides themselves still ship for local re-runs and pin down
 * the precedence, fallbacks, and malformed-value behavior so a typo
 * never silently relaxes the gate.
 */

const CONFIG = Object.freeze({
  newMethodCeiling: 30,
  tolerance: 0.001,
  refreshTag: 'baseline-refresh:',
});

test('resolveCrapEnvOverrides — no env vars: returns config values, no overrides', () => {
  const result = resolveCrapEnvOverrides(CONFIG, {});
  assert.strictEqual(result.newMethodCeiling, 30);
  assert.strictEqual(result.tolerance, 0.001);
  assert.strictEqual(result.refreshTag, 'baseline-refresh:');
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveCrapEnvOverrides — CRAP_NEW_METHOD_CEILING overrides config', () => {
  const result = resolveCrapEnvOverrides(CONFIG, {
    CRAP_NEW_METHOD_CEILING: '15',
  });
  assert.strictEqual(result.newMethodCeiling, 15);
  assert.strictEqual(result.tolerance, 0.001);
  assert.ok(
    result.overrides.some((o) => o.includes('CRAP_NEW_METHOD_CEILING')),
    'override list should name CRAP_NEW_METHOD_CEILING',
  );
});

test('resolveCrapEnvOverrides — CRAP_TOLERANCE overrides config', () => {
  const result = resolveCrapEnvOverrides(CONFIG, {
    CRAP_TOLERANCE: '0.5',
  });
  assert.strictEqual(result.tolerance, 0.5);
  assert.ok(
    result.overrides.some((o) => o.includes('CRAP_TOLERANCE')),
    'override list should name CRAP_TOLERANCE',
  );
});

test('resolveCrapEnvOverrides — CRAP_REFRESH_TAG overrides config', () => {
  const result = resolveCrapEnvOverrides(CONFIG, {
    CRAP_REFRESH_TAG: 'chore(refresh):',
  });
  assert.strictEqual(result.refreshTag, 'chore(refresh):');
  assert.ok(
    result.overrides.some((o) => o.includes('CRAP_REFRESH_TAG')),
    'override list should name CRAP_REFRESH_TAG',
  );
});

test('resolveCrapEnvOverrides — all three env vars override together', () => {
  const result = resolveCrapEnvOverrides(CONFIG, {
    CRAP_NEW_METHOD_CEILING: '20',
    CRAP_TOLERANCE: '0.01',
    CRAP_REFRESH_TAG: 'refresh:',
  });
  assert.strictEqual(result.newMethodCeiling, 20);
  assert.strictEqual(result.tolerance, 0.01);
  assert.strictEqual(result.refreshTag, 'refresh:');
  assert.strictEqual(result.overrides.length, 3);
});

test('resolveCrapEnvOverrides — empty-string env var is treated as unset', () => {
  const result = resolveCrapEnvOverrides(CONFIG, {
    CRAP_NEW_METHOD_CEILING: '',
    CRAP_TOLERANCE: '',
    CRAP_REFRESH_TAG: '',
  });
  assert.strictEqual(result.newMethodCeiling, 30);
  assert.strictEqual(result.tolerance, 0.001);
  assert.strictEqual(result.refreshTag, 'baseline-refresh:');
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveCrapEnvOverrides — malformed numeric env var warns and keeps config', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const result = resolveCrapEnvOverrides(CONFIG, {
      CRAP_NEW_METHOD_CEILING: 'banana',
      CRAP_TOLERANCE: 'NaN',
    });
    assert.strictEqual(result.newMethodCeiling, 30);
    assert.strictEqual(result.tolerance, 0.001);
    assert.deepStrictEqual(result.overrides, []);
    assert.ok(
      warnings.some((w) => w.includes('CRAP_NEW_METHOD_CEILING')),
      'should warn about malformed ceiling',
    );
    assert.ok(
      warnings.some((w) => w.includes('CRAP_TOLERANCE')),
      'should warn about malformed tolerance',
    );
  } finally {
    console.warn = origWarn;
  }
});

test('resolveCrapEnvOverrides — negative numeric env var is rejected', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const result = resolveCrapEnvOverrides(CONFIG, {
      CRAP_NEW_METHOD_CEILING: '-5',
      CRAP_TOLERANCE: '-0.1',
    });
    assert.strictEqual(result.newMethodCeiling, 30);
    assert.strictEqual(result.tolerance, 0.001);
    assert.strictEqual(warnings.length, 2);
  } finally {
    console.warn = origWarn;
  }
});

test('resolveCrapEnvOverrides — missing config fields fall back to documented defaults', () => {
  const result = resolveCrapEnvOverrides({}, {});
  assert.strictEqual(result.newMethodCeiling, 30);
  // Default tolerance bumped 0.001 → 0.05 in 5.36.1; see check-crap.js
  // for the cross-environment-rounding rationale.
  assert.strictEqual(result.tolerance, 0.05);
  assert.strictEqual(result.refreshTag, 'baseline-refresh:');
});

test('resolveMaintainabilityEnvOverrides — CRAP_TOLERANCE overrides default', () => {
  const result = resolveMaintainabilityEnvOverrides({ CRAP_TOLERANCE: '0.25' });
  assert.strictEqual(result.tolerance, 0.25);
  assert.ok(result.overrides.some((o) => o.includes('CRAP_TOLERANCE')));
});

test('resolveMaintainabilityEnvOverrides — no env: returns default (0.5, raised from 0.001 to absorb noise)', () => {
  const result = resolveMaintainabilityEnvOverrides({});
  assert.strictEqual(result.tolerance, 0.5);
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveMaintainabilityEnvOverrides — malformed value warns and keeps prior layer', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const result = resolveMaintainabilityEnvOverrides({
      CRAP_TOLERANCE: 'banana',
    });
    assert.strictEqual(result.tolerance, 0.5);
    assert.strictEqual(result.overrides.length, 0);
    assert.ok(warnings[0].includes('CRAP_TOLERANCE'));
  } finally {
    console.warn = origWarn;
  }
});

test('resolveMaintainabilityEnvOverrides — config tolerance overrides default', () => {
  const result = resolveMaintainabilityEnvOverrides({}, { tolerance: 0.75 });
  assert.strictEqual(result.tolerance, 0.75);
  assert.ok(
    result.overrides.some((o) =>
      o.includes('quality.maintainability.tolerance'),
    ),
    'override list should name the config source',
  );
});

test('resolveMaintainabilityEnvOverrides — env beats config (CI override takes precedence)', () => {
  const result = resolveMaintainabilityEnvOverrides(
    { CRAP_TOLERANCE: '0.1' },
    { tolerance: 0.75 },
  );
  assert.strictEqual(result.tolerance, 0.1);
  // Both overrides observed; env wins last so it's the effective value.
  assert.ok(result.overrides.some((o) => o.includes('CRAP_TOLERANCE')));
  assert.ok(
    result.overrides.some((o) =>
      o.includes('quality.maintainability.tolerance'),
    ),
  );
});

test('resolveMaintainabilityEnvOverrides — malformed env falls back to config, not default', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const result = resolveMaintainabilityEnvOverrides(
      { CRAP_TOLERANCE: 'banana' },
      { tolerance: 0.75 },
    );
    // env malformed → fall through to config (0.75), NOT default (0.5).
    assert.strictEqual(result.tolerance, 0.75);
    assert.ok(warnings[0].includes('CRAP_TOLERANCE'));
  } finally {
    console.warn = origWarn;
  }
});

test('resolveMaintainabilityEnvOverrides — negative config value is ignored (defensive)', () => {
  const result = resolveMaintainabilityEnvOverrides({}, { tolerance: -1 });
  // Negative tolerance is nonsensical; the resolver guards on >= 0 so the
  // bad value falls through to the default.
  assert.strictEqual(result.tolerance, 0.5);
});
