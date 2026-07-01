import assert from 'node:assert';
import { test } from 'node:test';
import { resolveBundleSizeEnvOverrides } from '../.agents/scripts/lib/baselines/env-overrides.js';

/**
 * Tests for `resolveBundleSizeEnvOverrides` (Story #151 upstream port,
 * mandrel-platform#151 / PR #156). Mirrors the precedence + malformed-value
 * coverage style of `tests/check-crap-env-overrides.test.js` for the
 * `CRAP_TOLERANCE` resolver — pinning that `BUNDLE_SIZE_REFRESH` is a true
 * one-shot acknowledge flag: no persistence, strict truthy-value parsing,
 * case-insensitive, and a no-op (not a crash) on anything malformed.
 */

test('resolveBundleSizeEnvOverrides — no env var: not acknowledged, no overrides', () => {
  const result = resolveBundleSizeEnvOverrides({});
  assert.strictEqual(result.acknowledged, false);
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveBundleSizeEnvOverrides — undefined env object: not acknowledged', () => {
  const result = resolveBundleSizeEnvOverrides(undefined);
  assert.strictEqual(result.acknowledged, false);
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveBundleSizeEnvOverrides — BUNDLE_SIZE_REFRESH=1 acknowledges', () => {
  const result = resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: '1' });
  assert.strictEqual(result.acknowledged, true);
  assert.strictEqual(result.overrides.length, 1);
  assert.ok(result.overrides[0].includes('BUNDLE_SIZE_REFRESH=1'));
});

test('resolveBundleSizeEnvOverrides — BUNDLE_SIZE_REFRESH=true acknowledges', () => {
  const result = resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: 'true' });
  assert.strictEqual(result.acknowledged, true);
  assert.ok(result.overrides[0].includes('BUNDLE_SIZE_REFRESH=true'));
});

test('resolveBundleSizeEnvOverrides — case-insensitive truthy values (TRUE, True)', () => {
  assert.strictEqual(
    resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: 'TRUE' }).acknowledged,
    true,
  );
  assert.strictEqual(
    resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: 'True' }).acknowledged,
    true,
  );
});

test('resolveBundleSizeEnvOverrides — surrounding whitespace is trimmed before matching', () => {
  const result = resolveBundleSizeEnvOverrides({
    BUNDLE_SIZE_REFRESH: '  1  ',
  });
  assert.strictEqual(result.acknowledged, true);
});

test('resolveBundleSizeEnvOverrides — empty string is treated as unset', () => {
  const result = resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: '' });
  assert.strictEqual(result.acknowledged, false);
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveBundleSizeEnvOverrides — malformed value (e.g. "yes") is a no-op, not acknowledged', () => {
  const result = resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: 'yes' });
  assert.strictEqual(result.acknowledged, false);
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveBundleSizeEnvOverrides — "0" and "false" are not acknowledged', () => {
  assert.strictEqual(
    resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: '0' }).acknowledged,
    false,
  );
  assert.strictEqual(
    resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: 'false' })
      .acknowledged,
    false,
  );
});

test('resolveBundleSizeEnvOverrides — numeric non-string env values are ignored (defensive)', () => {
  // process.env values are always strings in real life, but the resolver
  // should not throw or misbehave if a test/caller passes a non-string.
  const result = resolveBundleSizeEnvOverrides({ BUNDLE_SIZE_REFRESH: 1 });
  assert.strictEqual(result.acknowledged, false);
  assert.deepStrictEqual(result.overrides, []);
});

test('resolveBundleSizeEnvOverrides — other env vars present do not interfere', () => {
  const result = resolveBundleSizeEnvOverrides({
    CRAP_TOLERANCE: '0.5',
    BUNDLE_SIZE_REFRESH: '1',
    PATH: '/usr/bin',
  });
  assert.strictEqual(result.acknowledged, true);
  assert.strictEqual(result.overrides.length, 1);
});
