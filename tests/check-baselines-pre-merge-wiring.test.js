// tests/check-baselines-pre-merge-wiring.test.js
//
// Story #1912 / Task #1917 — `check-baselines` is wired into the pre-merge
// gate chain alongside (NOT in place of) the existing per-kind regression
// gates. Pins the contract until Epic #1943 collapses the list.

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

  it('check-baselines runs AFTER the per-kind regression gates (still order-sensitive)', () => {
    const gates = buildDefaultGates({
      agentSettings: { quality: { crap: { enabled: true } } },
    });
    const names = gates.map((g) => g.name);
    const idxBaselines = names.indexOf('check-baselines');
    const idxMaintain = names.indexOf('check-maintainability');
    const idxCrap = names.indexOf('check-crap');
    assert.ok(idxBaselines > idxMaintain);
    assert.ok(idxBaselines > idxCrap);
  });

  it('per-kind regression gates remain in the chain (no removal in #1912)', () => {
    const gates = buildDefaultGates({
      agentSettings: { quality: { crap: { enabled: true } } },
    });
    const names = gates.map((g) => g.name);
    for (const kind of ['check-maintainability', 'check-crap']) {
      assert.ok(
        names.includes(kind),
        `expected ${kind} alongside check-baselines; got ${names.join(', ')}`,
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
