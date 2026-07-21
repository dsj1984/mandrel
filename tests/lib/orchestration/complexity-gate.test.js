// tests/lib/orchestration/complexity-gate.test.js
//
// Unit tier (Story #4683): the plan-time ceremony-lite complexity gate.
// Pins the deterministic trivial-vs-full routing (AC-1: a trivial seed routes
// `lite`, a multi-capability seed routes `full`), the configuration override
// knob, the conservative fail-toward-`full` posture, and — the AC-2 contract —
// that every `lite` decision preserves the non-negotiables (Story ticket, PR to
// main, repo gates, security baseline) that the collapsed path must never drop.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { buildComplexityRouteSignal } from '../../../.agents/scripts/lib/orchestration/complexity-gate.js';

describe('buildComplexityRouteSignal — deterministic routing (AC-1)', () => {
  test('a trivial single-artifact seed routes lite', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Add a hello-world script that prints "hello" and exits 0.',
    });
    assert.equal(signal.route, 'lite');
    assert.equal(signal.advisory, true);
    assert.ok(Array.isArray(signal.reasons) && signal.reasons.length > 0);
    assert.match(signal.reasons[0], /trivial single-artifact scope/i);
  });

  test('a multi-capability enumerated seed routes full', () => {
    const seedText = [
      'Overhaul the platform:',
      '- add OAuth login',
      '- add a billing dashboard',
      '- add an admin audit log',
    ].join('\n');
    const signal = buildComplexityRouteSignal({ seedText });
    assert.equal(signal.route, 'full');
    assert.match(signal.reasons[0], /multi-capability scope/i);
  });

  test('deterministic — identical input yields an identical decision', () => {
    const seedText = 'Fix the footer copyright year.';
    const a = buildComplexityRouteSignal({ seedText });
    const b = buildComplexityRouteSignal({ seedText });
    assert.deepEqual(a, b);
    assert.equal(a.route, 'lite');
  });

  test('a single enumerated item (≤ maxArtifacts) still routes lite', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Tidy the CLI help:\n- rename the --verbose flag to --debug',
    });
    assert.equal(signal.route, 'lite');
  });
});

describe('buildComplexityRouteSignal — conservative fail-toward-full', () => {
  test('an empty seed routes full (triviality cannot be judged)', () => {
    for (const seedText of ['', '   \n\t', undefined, null]) {
      const signal = buildComplexityRouteSignal({ seedText });
      assert.equal(signal.route, 'full');
    }
  });

  test('a seed above the word ceiling routes full', () => {
    const seedText = `refactor ${'word '.repeat(80)}`.trim();
    const signal = buildComplexityRouteSignal({ seedText });
    assert.equal(signal.route, 'full');
    assert.match(signal.reasons[0], /not a trivial scope/i);
  });
});

describe('buildComplexityRouteSignal — configuration override knob (AC-1)', () => {
  test('planning.complexityGate.enabled=false forces every seed to full', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'trivial one-liner',
      config: { planning: { complexityGate: { enabled: false } } },
    });
    assert.equal(signal.route, 'full');
    assert.match(signal.reasons[0], /complexity gate disabled/i);
  });

  test('lowering maxSeedWords flips a formerly-lite seed to full', () => {
    const seedText = 'Add a small helper that formats a duration string.';
    assert.equal(buildComplexityRouteSignal({ seedText }).route, 'lite');
    const tightened = buildComplexityRouteSignal({
      seedText,
      config: { planning: { complexityGate: { maxSeedWords: 3 } } },
    });
    assert.equal(tightened.route, 'full');
    assert.equal(tightened.threshold.maxSeedWords, 3);
  });

  test('raising maxArtifacts admits a two-item seed to the lite path', () => {
    const seedText = 'Tidy up:\n- rename a flag\n- update its help text';
    assert.equal(buildComplexityRouteSignal({ seedText }).route, 'full');
    const widened = buildComplexityRouteSignal({
      seedText,
      config: { planning: { complexityGate: { maxArtifacts: 2 } } },
    });
    assert.equal(widened.route, 'lite');
    assert.equal(widened.threshold.maxArtifacts, 2);
  });

  test('a malformed/negative ceiling falls back to the conservative default', () => {
    const seedText = 'Add a small helper that formats a duration string.';
    const signal = buildComplexityRouteSignal({
      seedText,
      config: {
        planning: { complexityGate: { maxSeedWords: -5, maxArtifacts: 'x' } },
      },
    });
    // Defaults restored, so the trivial seed still routes lite.
    assert.equal(signal.route, 'lite');
    assert.equal(signal.threshold.maxSeedWords, 60);
    assert.equal(signal.threshold.maxArtifacts, 1);
  });
});

describe('buildComplexityRouteSignal — lite-path non-negotiables (AC-2)', () => {
  const NON_NEGOTIABLES = [
    'storyTicket',
    'prToMain',
    'repoGates',
    'securityBaseline',
  ];

  test('every lite decision preserves the Story ticket, PR-to-main, gates, and security baseline', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Add a hello-world script that prints "hello".',
    });
    assert.equal(signal.route, 'lite');
    assert.ok(signal.preserves && typeof signal.preserves === 'object');
    for (const key of NON_NEGOTIABLES) {
      assert.equal(
        signal.preserves[key],
        true,
        `lite path must preserve ${key}`,
      );
    }
  });

  test('the full route carries the same non-negotiables — no route ever drops one', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Overhaul:\n- a\n- b\n- c',
    });
    assert.equal(signal.route, 'full');
    for (const key of NON_NEGOTIABLES) {
      assert.equal(signal.preserves[key], true);
    }
  });

  test('the preserves contract is immutable (frozen)', () => {
    const signal = buildComplexityRouteSignal({ seedText: 'trivial' });
    assert.ok(Object.isFrozen(signal.preserves));
  });
});
