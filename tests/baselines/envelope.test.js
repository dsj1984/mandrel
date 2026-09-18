import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEnvelope,
  buildEnvelope,
} from '../../.agents/scripts/lib/baselines/envelope.js';

// ---------------------------------------------------------------------------
// envelope.test.js — assembly + AJV validation of the shared baseline
// envelope (Story #1891). Covers:
//   - $schema / kernelVersion stamping (no run timestamp, no rollup)
//   - missing-key rejection for every required top-level key
//   - rejection of the retired generatedAt / rollup keys (Story #5400)
//   - cross-kind schema validation (the kind in $schema is the one AJV uses)
// ---------------------------------------------------------------------------

function canonicalMaintainability() {
  return buildEnvelope({
    kind: 'maintainability',
    kernelVersion: '1.0.0',
    rows: [{ path: 'src/a.js', mi: 80 }],
  });
}

describe('buildEnvelope()', () => {
  it('stamps $schema and kernelVersion and carries no generatedAt or rollup', () => {
    const env = canonicalMaintainability();
    assert.equal(
      env.$schema,
      '.agents/schemas/baselines/maintainability.schema.json',
    );
    assert.equal(env.kernelVersion, '1.0.0');
    assert.deepEqual(Object.keys(env), ['$schema', 'kernelVersion', 'rows']);
  });

  it('rejects an unknown kind', () => {
    assert.throws(
      () =>
        buildEnvelope({
          kind: 'nope',
          kernelVersion: '1.0.0',
          rows: [],
        }),
      /kind must be one of/,
    );
  });

  it('rejects a non-semver kernelVersion', () => {
    assert.throws(
      () =>
        buildEnvelope({
          kind: 'maintainability',
          kernelVersion: 'v1',
          rows: [],
        }),
      /kernelVersion must be semver-shaped/,
    );
  });
});

describe('assertEnvelope()', () => {
  it('accepts a canonical maintainability envelope', () => {
    assert.doesNotThrow(() => assertEnvelope(canonicalMaintainability()));
  });

  it('accepts a canonical crap envelope', () => {
    const env = buildEnvelope({
      kind: 'crap',
      kernelVersion: '1.0.0',
      rows: [{ path: 'src/a.js', method: 'foo', startLine: 1, crap: 2.5 }],
    });
    assert.doesNotThrow(() => assertEnvelope(env));
  });

  for (const key of ['$schema', 'kernelVersion', 'rows']) {
    it(`rejects an envelope missing the top-level "${key}" key`, () => {
      const env = canonicalMaintainability();
      delete env[key];
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.throws(() => assertEnvelope(env), new RegExp(escapedKey));
    });
  }

  for (const [key, value] of [
    ['generatedAt', '2026-01-01T00:00:00Z'],
    ['rollup', { '*': { min: 80, p50: 80, p95: 80 } }],
  ]) {
    it(`rejects an envelope carrying the retired "${key}" key`, () => {
      const env = { ...canonicalMaintainability(), [key]: value };
      assert.throws(() => assertEnvelope(env), new RegExp(key));
    });
  }

  it('rejects an envelope whose $schema is not one of the known kinds', () => {
    const env = canonicalMaintainability();
    env.$schema = '.agents/schemas/baselines/unknown.schema.json';
    assert.throws(() => assertEnvelope(env), /known kinds/);
  });

  it('rejects an envelope whose row shape disagrees with the schema', () => {
    const env = canonicalMaintainability();
    env.rows = [{ path: 'src/a.js' }]; // missing mi
    assert.throws(() => assertEnvelope(env), /schema validation/);
  });

  it('rejects null / non-object input', () => {
    assert.throws(() => assertEnvelope(null), TypeError);
    assert.throws(() => assertEnvelope('not an envelope'), TypeError);
    assert.throws(() => assertEnvelope([]), TypeError);
  });
});
