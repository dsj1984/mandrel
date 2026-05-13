import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyFloorPolicy,
  parseFloorFlag,
} from '../../.agents/scripts/lib/quality-floors.js';

/**
 * Regression tests for the Story #1602 floor wiring in
 * `.agents/scripts/check-coverage-baseline.js`.
 *
 * The checker is a top-level `main()` CLI (no `runAsCli` wrapper) that
 * `process.exit`s in three branches:
 *   1. ratchet-only: regressions or new files.
 *   2. floor-only: in-scope file below 90/85/90 even though the baseline matched.
 *   3. combined: both surfaces fire.
 *
 * The integration plumbing is exercised by `npm run coverage:check` itself;
 * these tests target the units the checker imports so a future refactor of
 * the gate cannot silently drop the floor enforcement.
 */

describe('check-coverage-baseline — --floor flag parsing', () => {
  it('defaults to floor=on when no flag is supplied', () => {
    assert.equal(parseFloorFlag([]), true);
  });
  it('--floor=off disables the floor gate', () => {
    assert.equal(parseFloorFlag(['--floor=off']), false);
  });
  it('--no-floor disables the floor gate (alias)', () => {
    assert.equal(parseFloorFlag(['--no-floor']), false);
  });
  it('--floor off (space form) disables the floor gate', () => {
    assert.equal(parseFloorFlag(['--floor', 'off']), false);
  });
});

describe('check-coverage-baseline — floor policy semantics', () => {
  const floors = {
    coverage: { lines: 90, branches: 85, functions: 90 },
    maintainability: 70,
    crap: 20,
  };

  it('ratchet-only: file at baseline but below floor still trips the floor gate', () => {
    // The ratchet would pass (no drop), but the absolute floor must still
    // fire — that's the core contract of Story #1602.
    const { violations } = applyFloorPolicy(
      [{ file: 'lib/x.js', lines: 82, branches: 70, functions: 88 }],
      floors,
      'coverage',
    );
    const axes = violations.map((v) => v.axis).sort();
    assert.deepEqual(axes, ['branches', 'functions', 'lines']);
  });

  it('floor-only: all axes above floor → no floor violation', () => {
    const { violations } = applyFloorPolicy(
      [{ file: 'lib/y.js', lines: 95, branches: 90, functions: 92 }],
      floors,
      'coverage',
    );
    assert.equal(violations.length, 0);
  });

  it('combined: multiple files mixed below and above floor', () => {
    const { violations, passed } = applyFloorPolicy(
      [
        { file: 'lib/lo.js', lines: 50, branches: 60, functions: 70 },
        { file: 'lib/hi.js', lines: 95, branches: 90, functions: 95 },
      ],
      floors,
      'coverage',
    );
    const failingFiles = new Set(violations.map((v) => v.file));
    assert.ok(failingFiles.has('lib/lo.js'));
    assert.equal(failingFiles.has('lib/hi.js'), false);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].file, 'lib/hi.js');
  });
});
