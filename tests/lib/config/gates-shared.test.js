import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gateBase } from '../../../.agents/scripts/lib/config/gates/shared.js';

describe('gateBase', () => {
  it('omits every default annotation when no defaults are supplied', () => {
    const fragment = gateBase();
    assert.equal('default' in fragment.enabled, false);
    assert.equal('default' in fragment.baselinePath, false);
    assert.equal('default' in fragment.tolerance, false);
    assert.equal('default' in fragment.floors, false);
    assert.equal(fragment.tolerance.type, 'object');
    assert.deepEqual(fragment.tolerance.required, ['kind', 'value']);
    assert.equal(fragment.components.type, 'object');
  });

  it('annotates each supplied default on its own property', () => {
    const tolerance = { kind: 'absolute', value: 0 };
    const floors = { '*': { crap: 2 } };
    const fragment = gateBase({
      enabled: false,
      baselinePath: 'baselines/x.json',
      tolerance,
      floors,
    });
    assert.equal(fragment.enabled.default, false);
    assert.equal(fragment.baselinePath.default, 'baselines/x.json');
    assert.deepEqual(fragment.tolerance.default, tolerance);
    assert.deepEqual(fragment.floors.default, floors);
    assert.equal(fragment.baselinePath.minLength, 1);
  });

  it('returns a fresh fragment on every call', () => {
    assert.notEqual(gateBase().enabled, gateBase().enabled);
  });
});
