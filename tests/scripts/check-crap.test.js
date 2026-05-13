import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyFloorPolicy,
  parseFloorFlag,
} from '../../.agents/scripts/lib/quality-floors.js';

/**
 * Regression tests for the Story #1602 floor wiring in
 * `.agents/scripts/check-crap.js`. The checker's main() returns an exit
 * code after the ratchet block; the floor block fires when the ratchet
 * passed but a per-method CRAP score exceeds the configured ceiling.
 */

describe('check-crap — --floor flag parsing', () => {
  it('defaults to floor=on', () => {
    assert.equal(parseFloorFlag([]), true);
  });
  it('--no-floor disables the floor gate', () => {
    assert.equal(parseFloorFlag(['--no-floor']), false);
  });
  it('--floor=false disables the floor gate (alt form)', () => {
    assert.equal(parseFloorFlag(['--floor=false']), false);
  });
});

describe('check-crap — floor policy semantics', () => {
  const floors = {
    coverage: { lines: 90, branches: 85, functions: 90 },
    maintainability: 70,
    crap: 20,
  };

  it('ratchet-only: method matched baseline but CRAP > 20 still trips floor', () => {
    const { violations } = applyFloorPolicy(
      [{ file: 'lib/legacy.js', method: 'doWork', score: 25.5 }],
      floors,
      'crap',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].method, 'doWork');
    assert.equal(violations[0].reason, 'above-ceiling');
    assert.equal(violations[0].floor, 20);
  });

  it('floor-only: every method ≤20 passes', () => {
    const { violations, passed } = applyFloorPolicy(
      [
        { file: 'a.js', method: 'one', score: 10 },
        { file: 'a.js', method: 'two', score: 20 },
      ],
      floors,
      'crap',
    );
    assert.equal(violations.length, 0);
    assert.equal(passed.length, 2);
  });

  it('combined: surfaces only methods above ceiling, keeps the rest passing', () => {
    const { violations, passed } = applyFloorPolicy(
      [
        { file: 'a.js', method: 'cheap', score: 4 },
        { file: 'a.js', method: 'expensive', score: 45 },
        { file: 'b.js', method: 'fine', score: 18 },
      ],
      floors,
      'crap',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].method, 'expensive');
    assert.equal(passed.length, 2);
  });
});
