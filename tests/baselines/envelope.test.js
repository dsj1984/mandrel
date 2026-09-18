import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  assertEnvelope,
  buildEnvelope,
} from '../../.agents/scripts/lib/baselines/envelope.js';

// ---------------------------------------------------------------------------
// envelope.test.js — assembly + AJV validation of the shared baseline
// envelope (Story #1891). Covers:
//   - $schema / kernelVersion / generatedAt stamping
//   - MANDREL_BASELINE_GENERATED_AT env-var override
//   - missing-key rejection for every required top-level key
//   - cross-kind schema validation (the kind in $schema is the one AJV uses)
// ---------------------------------------------------------------------------

function canonicalMaintainability() {
  return buildEnvelope({
    kind: 'maintainability',
    kernelVersion: '1.0.0',
    rollup: { '*': { min: 80, p50: 80, p95: 80 } },
    rows: [{ path: 'src/a.js', mi: 80 }],
  });
}

describe('buildEnvelope()', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.MANDREL_BASELINE_GENERATED_AT;
    delete process.env.MANDREL_BASELINE_GENERATED_AT;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.MANDREL_BASELINE_GENERATED_AT;
    } else {
      process.env.MANDREL_BASELINE_GENERATED_AT = savedEnv;
    }
  });

  it('stamps $schema, kernelVersion, and generatedAt', () => {
    const env = canonicalMaintainability();
    assert.equal(
      env.$schema,
      '.agents/schemas/baselines/maintainability.schema.json',
    );
    assert.equal(env.kernelVersion, '1.0.0');
    assert.ok(typeof env.generatedAt === 'string');
    assert.match(env.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('MANDREL_BASELINE_GENERATED_AT overrides the runtime clock', () => {
    process.env.MANDREL_BASELINE_GENERATED_AT = '2026-01-01T00:00:00Z';
    const env = canonicalMaintainability();
    assert.equal(env.generatedAt, '2026-01-01T00:00:00Z');
  });

  it('an explicit generatedAt arg wins over the env var', () => {
    process.env.MANDREL_BASELINE_GENERATED_AT = '2026-01-01T00:00:00Z';
    const env = buildEnvelope({
      kind: 'maintainability',
      kernelVersion: '1.0.0',
      rollup: { '*': { min: 80, p50: 80, p95: 80 } },
      rows: [],
      generatedAt: '2099-12-31T23:59:59Z',
    });
    assert.equal(env.generatedAt, '2099-12-31T23:59:59Z');
  });

  it('rejects an unknown kind', () => {
    assert.throws(
      () =>
        buildEnvelope({
          kind: 'nope',
          kernelVersion: '1.0.0',
          rollup: { '*': {} },
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
          rollup: { '*': { min: 80, p50: 80, p95: 80 } },
          rows: [],
        }),
      /kernelVersion must be semver-shaped/,
    );
  });

  it('rejects a rollup that lacks the "*" key', () => {
    assert.throws(
      () =>
        buildEnvelope({
          kind: 'maintainability',
          kernelVersion: '1.0.0',
          rollup: { someComponent: {} },
          rows: [],
        }),
      /rollup\["\*"\]/,
    );
  });

  it('rejects a non-ISO generatedAt argument', () => {
    assert.throws(
      () =>
        buildEnvelope({
          kind: 'maintainability',
          kernelVersion: '1.0.0',
          rollup: { '*': { min: 80, p50: 80, p95: 80 } },
          rows: [],
          generatedAt: 'last tuesday',
        }),
      /ISO-8601/,
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
      rollup: { '*': { p50: 1, p95: 5, max: 10, methodsAbove20: 0 } },
      rows: [{ path: 'src/a.js', method: 'foo', startLine: 1, crap: 2.5 }],
    });
    assert.doesNotThrow(() => assertEnvelope(env));
  });

  for (const key of [
    '$schema',
    'kernelVersion',
    'generatedAt',
    'rollup',
    'rows',
  ]) {
    it(`rejects an envelope missing the top-level "${key}" key`, () => {
      const env = canonicalMaintainability();
      delete env[key];
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.throws(() => assertEnvelope(env), new RegExp(escapedKey));
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
