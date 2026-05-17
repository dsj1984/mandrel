// tests/check-baselines-pre-merge-wiring.test.js
//
// Story #1912 / Task #1917 — `check-baselines` is wired into the pre-merge
// gate chain as the unified baselines gate.
//
// Story #2210 retired the in-process per-kind regression gates
// (`check-maintainability`, `check-crap`, `check-mutation`). The
// `check-baselines` gate is now the single source of truth for per-kind
// regression enforcement — the chain no longer carries the per-kind
// arms alongside it, and the order-sensitivity that previously pinned
// `check-baselines` AFTER the per-kind gates is moot.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefaultGates } from '../.agents/scripts/lib/close-validation.js';

describe('pre-merge gate chain — Task #1917 contract', () => {
  it('buildDefaultGates includes the unified check-baselines gate', () => {
    const gates = buildDefaultGates({
      agentSettings: { quality: { crap: { enabled: true } } },
    });
    const names = gates.map((g) => g.name);
    assert.ok(
      names.includes('check-baselines'),
      `expected check-baselines in gate list; got ${names.join(', ')}`,
    );
  });

  it('per-kind in-process regression gates are absent (Story #2210 retirement)', () => {
    const gates = buildDefaultGates({
      agentSettings: { quality: { crap: { enabled: true } } },
    });
    const names = gates.map((g) => g.name);
    for (const kind of [
      'check-maintainability',
      'check-crap',
      'check-mutation',
    ]) {
      assert.ok(
        !names.includes(kind),
        `retired per-kind gate \`${kind}\` must not appear in the chain; got: ${names.join(', ')}`,
      );
    }
  });

  it('check-baselines invokes the new CLI', () => {
    const gates = buildDefaultGates({});
    const gate = gates.find((g) => g.name === 'check-baselines');
    assert.ok(gate);
    assert.equal(gate.cmd, 'node');
    assert.deepEqual(gate.args, [
      '.agents/scripts/check-baselines.js',
      '--format',
      'text',
    ]);
  });
});
