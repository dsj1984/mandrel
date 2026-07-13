/**
 * tests/lib/close-validation/baselines-gate-registration.test.js — Story #4495.
 *
 * The unified `check-baselines` gate reads a committed `baselines/<kind>.json`
 * for every enabled baseline kind. Registering it for a consumer that enables
 * baseline gates (crap/maintainability/…) but ships no committed `baselines/`
 * tree — every bench sandbox, any greenfield consumer — is a guaranteed
 * first-try close failure (read-miss → EXIT_SCHEMA). `buildDefaultGates` now
 * probes the consumer contract (`probeBaselinesGate`) and:
 *   - SKIPS the gate (with a logged reason) when baseline gates are enabled but
 *     no committed baseline artifact exists and `requireBaselines` is unset;
 *   - REGISTERS the gate normally when at least one committed baseline exists;
 *   - REGISTERS the gate with a preflight hint when baselines are
 *     required-by-config (`delivery.quality.requireBaselines: true`) but absent;
 *   - SKIPS the gate when no baseline gates are enabled at all.
 *
 * Baseline presence is injected via `presentBaselines` so the probe never
 * touches disk, mirroring the `packageScripts` injection in the sibling
 * coverage-gate-registration suite.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefaultGates } from '../../../.agents/scripts/lib/close-validation/gates.js';

const names = (gates) => gates.map((g) => g.name);
const crapEnabledConfig = {
  delivery: { quality: { gates: { crap: { enabled: true } } } },
};

describe('buildDefaultGates — check-baselines registration (Story #4495)', () => {
  it('enabled baseline kind + no committed baselines + requireBaselines unset → gate SKIPPED with a logged reason', () => {
    const logged = [];
    const gates = buildDefaultGates({
      config: crapEnabledConfig,
      presentBaselines: [],
      log: (m) => logged.push(m),
    });
    assert.ok(
      !names(gates).includes('check-baselines'),
      'check-baselines must not be registered without committed baselines',
    );
    assert.equal(logged.length, 1, 'the skip must be logged exactly once');
    assert.match(logged[0], /check-baselines skipped/);
    assert.match(logged[0], /crap/);
    assert.match(logged[0], /requireBaselines/);
  });

  it('enabled baseline kind + no committed baselines + requireBaselines:true → gate REGISTERED with a preflight hint (fail-closed)', () => {
    const logged = [];
    const gates = buildDefaultGates({
      config: {
        delivery: {
          quality: {
            requireBaselines: true,
            gates: { crap: { enabled: true } },
          },
        },
      },
      presentBaselines: [],
      log: (m) => logged.push(m),
    });
    assert.ok(
      names(gates).includes('check-baselines'),
      'requireBaselines keeps the gate registered so an absent artifact fails',
    );
    assert.equal(logged.length, 0, 'a registered gate emits no skip log');
    const gate = gates.find((g) => g.name === 'check-baselines');
    assert.match(gate.hint, /required \(delivery\.quality\.requireBaselines\)/);
    assert.match(gate.hint, /crap/);
    assert.match(gate.hint, /:update/);
  });

  it('enabled baseline kind + a committed baseline present → gate REGISTERED normally', () => {
    const gates = buildDefaultGates({
      config: crapEnabledConfig,
      presentBaselines: ['crap'],
    });
    assert.ok(names(gates).includes('check-baselines'));
    const gate = gates.find((g) => g.name === 'check-baselines');
    assert.deepEqual(gate.args, [
      '.agents/scripts/check-baselines.js',
      '--format',
      'text',
    ]);
    // Default breach hint (not the required-but-absent preflight hint).
    assert.match(gate.hint, /Unified baselines gate breached/);
  });

  it('no baseline gates enabled → gate REGISTERED (harmless empty pass, unchanged pre-#4495 behavior)', () => {
    const logged = [];
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: {} } } },
      presentBaselines: [],
      log: (m) => logged.push(m),
    });
    assert.ok(
      names(gates).includes('check-baselines'),
      'zero enabled kinds is a clean empty pass, not a first-try failure — keep the gate',
    );
    assert.equal(logged.length, 0, 'no skip when there is nothing to fail on');
  });

  it('a disabled kind does not count as enabled → treated as zero enabled kinds → gate REGISTERED', () => {
    const gates = buildDefaultGates({
      config: {
        delivery: { quality: { gates: { crap: { enabled: false } } } },
      },
      presentBaselines: [],
    });
    assert.ok(names(gates).includes('check-baselines'));
  });

  it('present baseline for only one of several enabled kinds → gate REGISTERED (tree exists)', () => {
    const gates = buildDefaultGates({
      config: {
        delivery: {
          quality: {
            gates: {
              crap: { enabled: true },
              maintainability: { enabled: true },
            },
          },
        },
      },
      presentBaselines: ['crap'],
    });
    assert.ok(names(gates).includes('check-baselines'));
  });
});
