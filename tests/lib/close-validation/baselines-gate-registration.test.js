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
 *
 * Story #5172 split the registered gate in two. When the enabled-kind set
 * resolves, the kinds that read no coverage artifact register as
 * `check-baselines-independent` (routed into the parallel partition) and the
 * coverage-consuming kinds as `check-baselines-coverage` (serial, behind
 * `coverage-capture`). The unsplit `check-baselines` name survives as the
 * fail-closed fallback for an unresolvable or empty kind set. Both halves of
 * the #4495 probe decision and the #3890 `BASELINE_REF` overlay bind every
 * entry identically.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASELINES_GATE_NAMES,
  buildDefaultGates,
  partitionGates,
} from '../../../.agents/scripts/lib/close-validation/gates.js';

const names = (gates) => gates.map((g) => g.name);
const crapEnabledConfig = {
  delivery: { quality: { gates: { crap: { enabled: true } } } },
};

/** Any baselines entry, whichever name this config registered it under. */
const baselinesEntries = (gates) =>
  gates.filter((g) => Object.values(BASELINES_GATE_NAMES).includes(g.name));

/** A config enabling exactly `kinds`. */
const configForKinds = (kinds, extra = {}) => ({
  delivery: {
    quality: {
      ...extra,
      gates: Object.fromEntries(kinds.map((k) => [k, { enabled: true }])),
    },
  },
});

describe('buildDefaultGates — check-baselines registration (Story #4495)', () => {
  it('enabled baseline kind + no committed baselines + requireBaselines unset → gate SKIPPED with a logged reason', () => {
    const logged = [];
    const gates = buildDefaultGates({
      config: crapEnabledConfig,
      presentBaselines: [],
      log: (m) => logged.push(m),
    });
    assert.deepEqual(
      baselinesEntries(gates),
      [],
      'no baselines entry may be registered without committed baselines',
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
    assert.deepEqual(
      names(baselinesEntries(gates)),
      [BASELINES_GATE_NAMES.coverage],
      'requireBaselines keeps the gate registered so an absent artifact fails',
    );
    assert.equal(logged.length, 0, 'a registered gate emits no skip log');
    const [gate] = baselinesEntries(gates);
    assert.match(gate.hint, /required \(delivery\.quality\.requireBaselines\)/);
    assert.match(gate.hint, /crap/);
    assert.match(gate.hint, /:update/);
  });

  it('enabled baseline kind + a committed baseline present → gate REGISTERED normally', () => {
    const gates = buildDefaultGates({
      config: crapEnabledConfig,
      presentBaselines: ['crap'],
    });
    assert.deepEqual(names(baselinesEntries(gates)), [
      BASELINES_GATE_NAMES.coverage,
    ]);
    const [gate] = baselinesEntries(gates);
    assert.deepEqual(gate.args, [
      '.agents/scripts/check-baselines.js',
      '--gate',
      'crap',
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
    assert.equal(baselinesEntries(gates).length, 2);
  });
});

describe('buildDefaultGates — baselines gate partition (Story #5172)', () => {
  const allKinds = ['maintainability', 'duplication', 'coverage', 'crap'];
  const present = ['maintainability', 'duplication', 'coverage', 'crap'];

  // AC-1 — the coverage-independent kinds fail in the parallel phase.
  it('routes the coverage-independent entry to independent and the coverage-consuming entry to serial', () => {
    const gates = buildDefaultGates({
      config: configForKinds(allKinds),
      presentBaselines: present,
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    const { independent, serial } = partitionGates(gates);
    assert.ok(
      names(independent).includes(BASELINES_GATE_NAMES.independent),
      `expected the coverage-independent entry in the parallel partition; got ${names(independent).join(', ')}`,
    );
    assert.ok(
      names(serial).includes(BASELINES_GATE_NAMES.coverage),
      `expected the coverage-consuming entry in the serial partition; got ${names(serial).join(', ')}`,
    );
    assert.ok(
      !names(independent).includes(BASELINES_GATE_NAMES.coverage),
      'the coverage-consuming entry must never run in parallel',
    );
    // Serial order is the fail-fast walk: the coverage artifact is written
    // before the gate that reads it.
    assert.ok(
      names(serial).indexOf('coverage-capture') <
        names(serial).indexOf(BASELINES_GATE_NAMES.coverage),
      'the coverage-consuming entry must stay behind coverage-capture',
    );
  });

  it('splits the kinds between the two entries with no kind counted twice or dropped', () => {
    const gates = buildDefaultGates({
      config: configForKinds(allKinds),
      presentBaselines: present,
    });
    const kindsOf = (name) => {
      const gate = gates.find((g) => g.name === name);
      return gate.args[gate.args.indexOf('--gate') + 1].split(',');
    };
    assert.deepEqual(kindsOf(BASELINES_GATE_NAMES.independent), [
      'maintainability',
      'duplication',
    ]);
    assert.deepEqual(kindsOf(BASELINES_GATE_NAMES.coverage), [
      'coverage',
      'crap',
    ]);
  });

  // AC-4 — neither bucket registers an entry with an empty kind set.
  it('registers no coverage-consuming entry when neither coverage nor crap is enabled', () => {
    const gates = buildDefaultGates({
      config: configForKinds(['maintainability', 'duplication']),
      presentBaselines: ['maintainability'],
    });
    assert.deepEqual(names(baselinesEntries(gates)), [
      BASELINES_GATE_NAMES.independent,
    ]);
  });

  it('registers no coverage-independent entry when only coverage-consuming kinds are enabled', () => {
    const gates = buildDefaultGates({
      config: configForKinds(['coverage', 'crap']),
      presentBaselines: ['coverage'],
    });
    assert.deepEqual(names(baselinesEntries(gates)), [
      BASELINES_GATE_NAMES.coverage,
    ]);
  });

  // AC-5 — enforcement never silently relaxes.
  it('falls back to the single serial check-baselines entry when the enabled-kind set cannot be resolved', () => {
    // A gate block whose read throws models the enabled-kinds view failing to
    // resolve: `enabledBaselineKinds` walks every known kind, so a config
    // whose resolution explodes part-way through cannot report which kinds
    // run. The throw is planted on a kind other than `crap` so the sibling
    // coverage-capture probe still resolves and the fixture isolates exactly
    // the partition's own fail-closed path.
    const hostile = {
      delivery: {
        quality: {
          gates: {
            crap: { enabled: true },
            get maintainability() {
              throw new Error('config resolution exploded');
            },
          },
        },
      },
    };
    const gates = buildDefaultGates({
      config: hostile,
      presentBaselines: [],
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    assert.deepEqual(names(baselinesEntries(gates)), [
      BASELINES_GATE_NAMES.single,
    ]);
    const [gate] = baselinesEntries(gates);
    assert.deepEqual(
      gate.args,
      ['.agents/scripts/check-baselines.js', '--format', 'text'],
      'the fallback runs every enabled kind, unfiltered, exactly as pre-split',
    );
    const { independent, serial } = partitionGates(gates);
    assert.ok(
      !names(independent).includes(BASELINES_GATE_NAMES.single),
      'the fallback keeps its historical serial position',
    );
    assert.equal(
      names(serial).at(-1),
      BASELINES_GATE_NAMES.single,
      'the fallback stays last in the serial walk',
    );
  });

  // AC-6 — both entries keep the #3890 env overlay and the #4495 decision.
  it('applies the BASELINE_REF overlay identically to both entries', () => {
    const gates = buildDefaultGates({
      config: configForKinds(allKinds),
      presentBaselines: present,
      baseBranch: 'main',
    });
    const entries = baselinesEntries(gates);
    assert.equal(entries.length, 2);
    for (const gate of entries) {
      assert.deepEqual(
        gate.env,
        { BASELINE_REF: 'origin/main' },
        `${gate.name} must carry the #3890 compare-base overlay`,
      );
    }
  });

  // Story #5954 AC-11 — a skipped base sync compares against the merge-base,
  // so a row main improved after it is no phantom regression.
  it('pins BASELINE_REF to the merge-base when the sync was skipped', () => {
    const mergeBase = 'm'.repeat(40);
    const entries = baselinesEntries(
      buildDefaultGates({
        config: configForKinds(allKinds),
        presentBaselines: present,
        baseBranch: 'main',
        baselineRef: mergeBase,
      }),
    );
    assert.equal(entries.length, 2);
    for (const gate of entries) {
      assert.deepEqual(gate.env, { BASELINE_REF: mergeBase });
    }
  });

  it('omits the overlay from both entries when no integration branch is supplied', () => {
    const entries = baselinesEntries(
      buildDefaultGates({
        config: configForKinds(allKinds),
        presentBaselines: present,
      }),
    );
    assert.equal(entries.length, 2);
    for (const gate of entries) {
      assert.ok(!('env' in gate), `${gate.name} must carry no overlay`);
    }
  });

  it('applies the #4495 skip decision to both entries at once', () => {
    const gates = buildDefaultGates({
      config: configForKinds(allKinds),
      presentBaselines: [],
    });
    assert.deepEqual(
      baselinesEntries(gates),
      [],
      'a skip decision must drop BOTH entries, never leave one registered',
    );
  });

  it('applies the requireBaselines preflight hint to both entries at once', () => {
    const entries = baselinesEntries(
      buildDefaultGates({
        config: configForKinds(allKinds, { requireBaselines: true }),
        presentBaselines: [],
      }),
    );
    assert.equal(entries.length, 2);
    for (const gate of entries) {
      assert.match(
        gate.hint,
        /required \(delivery\.quality\.requireBaselines\)/,
        `${gate.name} must carry the preflight hint`,
      );
    }
  });

  it('gives both entries the standard remediation hint when baselines are present', () => {
    const entries = baselinesEntries(
      buildDefaultGates({
        config: configForKinds(allKinds),
        presentBaselines: present,
      }),
    );
    assert.equal(entries.length, 2);
    for (const gate of entries) {
      assert.match(gate.hint, /Unified baselines gate breached/);
    }
  });
});
