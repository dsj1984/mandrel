// lib/migrations/__tests__/index.test.js
/**
 * Unit tests for lib/migrations/index.js — the version-keyed migration runner.
 *
 * All tests drive runMigrations through injected seams (a `log` capture and a
 * fixture `registry`) over an in-memory plain-object context, so no real
 * stdout write and no real filesystem I/O occur (testing-standards § Unit).
 *
 * Coverage contract (Story #3501 AC):
 *   - Module shape: runMigrations named export + ordered `migrations` registry
 *     array (which ships empty).
 *   - Version filtering: only steps with fromVersion < version <= toVersion
 *     apply, in ascending version order.
 *   - Idempotency: a second pass over the same context applies nothing
 *     (detect() returns false post-apply).
 *   - Log seam: each applied step prints `migrated <version>: <description>`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import runMigrations, { compareVersions, migrations } from '../index.js';

// ---------------------------------------------------------------------------
// Fixture steps
// ---------------------------------------------------------------------------

/**
 * Build a fixture step keyed on a context flag. `detect` returns true only
 * while the flag is unset; `apply` sets it. This satisfies the idempotency
 * contract: once applied, detect returns false.
 *
 * @param {string} version
 * @param {string} flag - ctx property the step toggles.
 * @returns {{ version: string, description: string, detect: Function, apply: Function }}
 */
function makeStep(version, flag) {
  return {
    version,
    description: `set ${flag}`,
    detect: (ctx) => ctx[flag] !== true,
    apply: (ctx) => {
      ctx[flag] = true;
    },
  };
}

/** A deliberately out-of-order registry to prove the runner sorts ascending. */
function fixtureRegistry() {
  return [
    makeStep('1.4.0', 'a140'),
    makeStep('1.2.0', 'a120'),
    makeStep('1.3.0', 'a130'),
    makeStep('1.5.0', 'a150'),
  ];
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('migrations module exports', () => {
  it('exports runMigrations as the default function', () => {
    assert.equal(typeof runMigrations, 'function');
  });

  it('exports an ordered `migrations` registry array', () => {
    assert.ok(Array.isArray(migrations));
  });

  // Story #4531 added the mi-drop-knobs retirement; Story #4545 appended the
  // verify-concurrency-cap retirement (both 2.1.0); Story #4604 appended the
  // epic-AC-tag retirement at 2.2.0; the Story #4722 follow-up appended the
  // maxSeedWords retirement at 2.11.0. The registry's declaration order is
  // what fixes the run order within a version — pin it.
  it('ships the real steps in ascending version + declaration order', () => {
    assert.equal(migrations.length, 4);
    assert.deepEqual(
      migrations.map((s) => s.version),
      ['2.1.0', '2.1.0', '2.2.0', '2.11.0'],
    );
    assert.match(migrations[0].description, /mi|maintainability/i);
    assert.match(migrations[1].description, /concurrency/i);
    assert.match(migrations[2].description, /epic-<id>-ac-N/);
    assert.match(migrations[3].description, /maxSeedWords/);
  });
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    assert.ok(compareVersions('1.2.0', '1.3.0') < 0);
    assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
    assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
    assert.ok(compareVersions('1.4.1', '1.4.0') > 0);
  });
});

// ---------------------------------------------------------------------------
// AC — version filtering + ascending order
// ---------------------------------------------------------------------------

describe('runMigrations — version filtering and ordering', () => {
  it('applies only steps with fromVersion < version <= toVersion, ascending', () => {
    const ctx = {};
    const order = [];
    const log = (msg) => order.push(msg);

    const result = runMigrations({
      fromVersion: '1.2.0',
      toVersion: '1.4.0',
      ctx,
      log,
      registry: fixtureRegistry(),
    });

    // 1.2.0 == fromVersion → excluded (already in the tree).
    // 1.5.0 > toVersion → excluded.
    // 1.3.0 and 1.4.0 apply, in ascending order.
    assert.deepEqual(result.applied, ['1.3.0', '1.4.0']);
    assert.deepEqual(order, [
      'migrated 1.3.0: set a130',
      'migrated 1.4.0: set a140',
    ]);
    assert.equal(ctx.a120, undefined);
    assert.equal(ctx.a130, true);
    assert.equal(ctx.a140, true);
    assert.equal(ctx.a150, undefined);
  });

  it('includes the step at exactly toVersion (inclusive upper bound)', () => {
    const ctx = {};
    const result = runMigrations({
      fromVersion: '1.2.0',
      toVersion: '1.5.0',
      ctx,
      log: () => {},
      registry: fixtureRegistry(),
    });
    assert.deepEqual(result.applied, ['1.3.0', '1.4.0', '1.5.0']);
  });

  it('excludes the step at exactly fromVersion (exclusive lower bound)', () => {
    const ctx = {};
    const result = runMigrations({
      fromVersion: '1.3.0',
      toVersion: '1.5.0',
      ctx,
      log: () => {},
      registry: fixtureRegistry(),
    });
    assert.deepEqual(result.applied, ['1.4.0', '1.5.0']);
    // 1.2.0 and 1.3.0 never ran.
    assert.equal(ctx.a120, undefined);
    assert.equal(ctx.a130, undefined);
  });

  it('applies nothing when the range is empty', () => {
    const ctx = {};
    const result = runMigrations({
      fromVersion: '1.5.0',
      toVersion: '1.5.0',
      ctx,
      log: () => {},
      registry: fixtureRegistry(),
    });
    assert.deepEqual(result.applied, []);
  });
});

// ---------------------------------------------------------------------------
// AC — idempotency
// ---------------------------------------------------------------------------

describe('runMigrations — idempotency', () => {
  it('applies nothing on a second pass over the same context', () => {
    const ctx = {};
    const registry = fixtureRegistry();
    const range = { fromVersion: '1.2.0', toVersion: '1.5.0', ctx, registry };

    const first = runMigrations({ ...range, log: () => {} });
    assert.deepEqual(first.applied, ['1.3.0', '1.4.0', '1.5.0']);

    const secondLog = [];
    const second = runMigrations({
      ...range,
      log: (msg) => secondLog.push(msg),
    });

    // Second pass: every in-range step is skipped because detect() now
    // returns false post-apply.
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['1.3.0', '1.4.0', '1.5.0']);
    assert.equal(secondLog.length, 0);
  });
});

// ---------------------------------------------------------------------------
// AC — log seam
// ---------------------------------------------------------------------------

describe('runMigrations — log seam', () => {
  it('prints `migrated <version>: <description>` for each applied step', () => {
    const lines = [];
    runMigrations({
      fromVersion: '1.0.0',
      toVersion: '1.3.0',
      ctx: {},
      log: (msg) => lines.push(msg),
      registry: [makeStep('1.3.0', 'a130')],
    });
    assert.deepEqual(lines, ['migrated 1.3.0: set a130']);
  });

  it('does not log a step that detect skips', () => {
    const lines = [];
    runMigrations({
      fromVersion: '1.0.0',
      toVersion: '1.3.0',
      ctx: { a130: true }, // already applied
      log: (msg) => lines.push(msg),
      registry: [makeStep('1.3.0', 'a130')],
    });
    assert.deepEqual(lines, []);
  });
});
