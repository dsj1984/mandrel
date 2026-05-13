import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyFloorPolicy,
  parseFloorFlag,
} from '../../.agents/scripts/lib/quality-floors.js';

/**
 * Regression tests for the Story #1602 floor wiring in
 * `.agents/scripts/check-maintainability.js`. The gate is async-main with
 * an explicit `process.exit(1)` on regressions and a follow-up floor block
 * after the regression block. These tests guard the three failure-mode
 * permutations the checker now distinguishes.
 */

describe('check-maintainability — --floor flag parsing', () => {
  it('defaults to floor=on when no flag is supplied', () => {
    assert.equal(parseFloorFlag([]), true);
  });
  it('--floor=off disables the floor gate (escape hatch)', () => {
    assert.equal(parseFloorFlag(['--floor=off']), false);
  });
  it('passes through unrelated flags', () => {
    assert.equal(
      parseFloorFlag(['--changed-since', 'main', '--story', '1602']),
      true,
    );
  });
});

describe('check-maintainability — floor policy semantics', () => {
  const floors = {
    coverage: { lines: 90, branches: 85, functions: 90 },
    maintainability: 70,
    crap: 20,
  };

  it('ratchet-only: file at baseline but MI < 70 still trips the floor gate', () => {
    const { violations } = applyFloorPolicy(
      [{ file: 'lib/old.js', mi: 65.0 }],
      floors,
      'maintainability',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'lib/old.js');
    assert.equal(violations[0].reason, 'below-floor');
    assert.equal(violations[0].floor, 70);
  });

  it('floor-only: MI exactly at 70 passes', () => {
    const { violations, passed } = applyFloorPolicy(
      [{ file: 'lib/edge.js', mi: 70 }],
      floors,
      'maintainability',
    );
    assert.equal(violations.length, 0);
    assert.equal(passed.length, 1);
  });

  it('combined: mixed file set surfaces every below-floor file', () => {
    const { violations } = applyFloorPolicy(
      [
        { file: 'a.js', mi: 65 },
        { file: 'b.js', mi: 71 },
        { file: 'c.js', mi: 50 },
      ],
      floors,
      'maintainability',
    );
    const files = violations.map((v) => v.file).sort();
    assert.deepEqual(files, ['a.js', 'c.js']);
  });
});
