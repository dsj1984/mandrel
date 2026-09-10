/**
 * tests/single-story-close-failed-gates.test.js
 *
 * The terminal schema's `gates` contract: "A gate the run skipped … reports
 * `skipped` rather than being omitted, so a missing gate is never mistaken
 * for a passing one."
 *
 * The failed-terminal builder used to name ONLY the gate that died and omit
 * the other two entirely — exactly the ambiguity the contract forbids. A
 * reader of a base-sync failure could not tell whether validation had passed
 * or had never run. Story #5172 added the baselines entries under their own
 * names so the cheap coverage-independent half is separable from the
 * coverage-consuming one.
 *
 * Story #5279 changes where those names come from. They used to be
 * RECONSTRUCTED from the dead phase over a hardcoded pair, so every failed
 * close reported both split names whether or not the run had ever registered
 * them: a config resolving to the unsplit `check-baselines`, or to one half of
 * the pair, got envelope keys for gates that did not exist, and a run that
 * died at `init` got them reported as `skipped` — which reads as "the gate is
 * turned off" rather than "there was no such gate". They are now REPORTED
 * from `observedGates` (the runner's `err.closeGates`), so a gate appears only
 * when the run observed it.
 *
 * The three phase-derived gates (`validation` / `baseSync` / `codeReview`) are
 * unchanged: they are pipeline phases, not registrations, so the strictly
 * sequential phase order still decides them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASELINES_GATE_NAMES } from '../.agents/scripts/lib/close-validation/gates.js';
import { gatesForFailedPhase } from '../.agents/scripts/single-story-close.js';

const PHASE_GATES = ['validation', 'baseSync', 'codeReview'];
const OUTCOMES = new Set(['passed', 'failed', 'skipped']);

const PHASES = [
  'init',
  'wrong-tree-guard',
  'base-sync',
  'close-validation',
  'push',
  'pull-request',
  'code-review',
  'auto-merge',
  'confirm-merge',
  'post-land',
];

describe('gatesForFailedPhase — the phase-derived gates', () => {
  it('always reports every phase gate, whatever phase died', () => {
    for (const phase of PHASES) {
      const gates = gatesForFailedPhase(phase, {});
      assert.deepEqual(
        Object.keys(gates).sort(),
        [...PHASE_GATES].sort(),
        `phase ${phase} must report every phase gate and nothing else`,
      );
      for (const [gate, outcome] of Object.entries(gates)) {
        assert.ok(
          OUTCOMES.has(outcome),
          `${gate}=${outcome} is not a schema outcome`,
        );
      }
    }
  });

  it('names the dead gate failed and leaves later gates skipped, not passed', () => {
    // Story #5172 — base-sync precedes close-validation, so reaching the
    // gates means the sync already cleared.
    assert.deepEqual(gatesForFailedPhase('close-validation', {}), {
      validation: 'failed',
      baseSync: 'passed',
      codeReview: 'skipped',
    });
  });

  it('reports a base-sync failure with validation never run (Story #5172 order)', () => {
    assert.deepEqual(gatesForFailedPhase('base-sync', {}), {
      validation: 'skipped',
      baseSync: 'failed',
      codeReview: 'skipped',
    });
  });

  it('reports gates the run had already cleared as passed', () => {
    // Reaching code-review means validation and base-sync completed — the
    // pipeline is strictly sequential.
    assert.deepEqual(gatesForFailedPhase('code-review', {}), {
      validation: 'passed',
      baseSync: 'passed',
      codeReview: 'failed',
    });
  });

  it('reports an operator-disabled gate as skipped, never passed', () => {
    assert.deepEqual(
      gatesForFailedPhase('code-review', {
        skipValidation: true,
        skipSync: true,
      }),
      { validation: 'skipped', baseSync: 'skipped', codeReview: 'failed' },
    );
  });

  it('degrades to all-skipped for an unrecognised phase rather than claiming passes', () => {
    assert.deepEqual(gatesForFailedPhase('not-a-phase', {}), {
      validation: 'skipped',
      baseSync: 'skipped',
      codeReview: 'skipped',
    });
  });
});

describe('gatesForFailedPhase — baselines entries are reported, not invented (Story #5279)', () => {
  const baselineKeys = (gates) =>
    Object.keys(gates).filter((k) => !PHASE_GATES.includes(k));

  it('AC-2: reports no baselines key at all when the run observed no gates', () => {
    // The regression: a run that died before close-validation ever registered
    // a gate still reported both split names. `skipped` is not a harmless
    // default here — it asserts a gate existed and was turned off.
    for (const phase of PHASES) {
      assert.deepEqual(
        baselineKeys(gatesForFailedPhase(phase, {})),
        [],
        `phase ${phase} must not invent a baselines gate`,
      );
    }
  });

  it('AC-2: reports exactly the split entries the run registered, and no phantom sibling', () => {
    const gates = gatesForFailedPhase('close-validation', {
      observedGates: { [BASELINES_GATE_NAMES.independent]: 'failed' },
    });
    assert.equal(gates[BASELINES_GATE_NAMES.independent], 'failed');
    assert.ok(
      !(BASELINES_GATE_NAMES.coverage in gates),
      'a config registering one half must not report the other',
    );
  });

  it('AC-2: reports the unsplit entry under its own name, as the success path does', () => {
    // `runner.js#baselinesEnvelopeGates` projects all three names on the
    // success path. Reporting only the split pair here meant one run's two
    // endings keyed the same gate differently.
    const gates = gatesForFailedPhase('push', {
      observedGates: { [BASELINES_GATE_NAMES.single]: 'passed' },
    });
    assert.equal(gates[BASELINES_GATE_NAMES.single], 'passed');
  });

  it('reports the observed outcome of each registered entry verbatim', () => {
    const gates = gatesForFailedPhase('close-validation', {
      observedGates: {
        [BASELINES_GATE_NAMES.independent]: 'passed',
        [BASELINES_GATE_NAMES.coverage]: 'failed',
      },
    });
    assert.equal(gates[BASELINES_GATE_NAMES.independent], 'passed');
    assert.equal(gates[BASELINES_GATE_NAMES.coverage], 'failed');
  });

  it('does not promote non-baselines gates to envelope keys', () => {
    // `lint` / `test` / `coverage-capture` roll up under `validation`; only
    // the baselines entries get their own key, or the envelope's gate map
    // becomes a second, contradictory copy of the gate log.
    const gates = gatesForFailedPhase('close-validation', {
      observedGates: { lint: 'failed', test: 'skipped' },
    });
    assert.deepEqual(baselineKeys(gates), []);
    assert.equal(gates.validation, 'failed');
  });

  it('tolerates a malformed observedGates rather than failing the failure path', () => {
    // This runs when the close already has one failure in hand; a second one
    // here would replace the cause the operator needs to see.
    for (const observedGates of [null, undefined, {}]) {
      assert.deepEqual(
        baselineKeys(
          gatesForFailedPhase('close-validation', { observedGates }),
        ),
        [],
      );
    }
  });
});
