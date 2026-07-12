/**
 * tests/lib/close-validation/coverage-gate-registration.test.js — Story #4473.
 *
 * The coverage-capture gate spawns `npm run test:coverage`, so registering it
 * for a consumer that has no such script is a guaranteed first-try close
 * failure — and because CRAP mode drops the plain `test` gate, that consumer
 * would have NO working test gate at all. `buildDefaultGates` now probes the
 * consumer's `package.json` (injected here via `packageScripts`) and:
 *   - registers coverage-capture ONLY when CRAP is on AND `test:coverage`
 *     exists;
 *   - restores the plain `test` gate whenever coverage-capture is not the
 *     active test runner, so there is always a working test gate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefaultGates } from '../../../.agents/scripts/lib/close-validation/gates.js';

const names = (gates) => gates.map((g) => g.name);

describe('buildDefaultGates — coverage-capture registration (Story #4473)', () => {
  it('CRAP on + test:coverage present → coverage-capture runs, no separate test gate', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    assert.ok(names(gates).includes('coverage-capture'));
    assert.ok(!names(gates).includes('test'));
  });

  it('CRAP on + test:coverage ABSENT → coverage-capture dropped, plain test gate restored', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
      packageScripts: { test: 'node --test' },
    });
    assert.ok(
      !names(gates).includes('coverage-capture'),
      'coverage-capture must not be registered without test:coverage',
    );
    assert.ok(
      names(gates).includes('test'),
      'the plain test gate is the degraded test runner',
    );
    const testGate = gates.find((g) => g.name === 'test');
    assert.deepEqual([testGate.cmd, ...testGate.args], ['npm', 'test']);
  });

  it('CRAP off → plain test gate present, coverage-capture absent (regardless of script)', () => {
    const gates = buildDefaultGates({
      config: {
        delivery: { quality: { gates: { crap: { enabled: false } } } },
      },
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    assert.ok(names(gates).includes('test'));
    assert.ok(!names(gates).includes('coverage-capture'));
  });

  it('no config (CRAP defaults on) + no coverage script → degraded test gate, no coverage-capture', () => {
    const gates = buildDefaultGates({ packageScripts: {} });
    assert.ok(names(gates).includes('test'));
    assert.ok(!names(gates).includes('coverage-capture'));
  });
});
