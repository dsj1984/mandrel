import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enforceMaintainabilityFloor } from '../.agents/scripts/lib/baselines/kinds/maintainability.js';
import {
  applyFloorPolicy,
  DEFAULT_FLOORS,
} from '../.agents/scripts/lib/quality-floors.js';

/**
 * Regression test for Story #1709 (Epic #1653): the absolute-floor gate
 * wired into `.husky/pre-push` and the CI coverage workflow MUST reject a
 * deliberately sub-floor file. The pre-push hook invokes:
 *
 *   npm run coverage:check       -- --full-scope
 *   npm run maintainability:check -- --full-scope
 *   npm run crap:check           -- --full-scope
 *
 * These three CLIs each delegate to `applyFloorPolicy` via their
 * `enforce*Floor` helpers; this test exercises the maintainability path
 * end-to-end through `enforceMaintainabilityFloor`, asserting that a
 * sub-floor MI score trips `process.exit(1)` and surfaces the canonical
 * "Absolute MI floor violated" error message. It also verifies the policy
 * helper used by all three gates classifies a sub-floor coverage record,
 * a sub-floor MI score, and an above-ceiling CRAP method as violations.
 */

describe('absolute-floor gate — pre-push regression', () => {
  it('enforceMaintainabilityFloor returns 1 when a file is below the MI floor', () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => {
      errors.push(args.map(String).join(' '));
    };

    const scores = {
      'lib/deliberately-sub-floor.js': DEFAULT_FLOORS.maintainability - 5,
      'lib/healthy.js': DEFAULT_FLOORS.maintainability + 10,
    };

    let result;
    try {
      result = enforceMaintainabilityFloor(scores, [], {
        floors: DEFAULT_FLOORS,
      });
    } finally {
      console.error = originalError;
    }

    assert.equal(
      result,
      1,
      'sub-floor file must return 1 — the CLI wrapper translates this into process.exit(1)',
    );
    const combined = errors.join('\n');
    assert.match(
      combined,
      /Absolute MI floor violated/,
      'gate must surface the canonical floor-violation banner',
    );
    assert.match(
      combined,
      /lib\/deliberately-sub-floor\.js/,
      'gate must name the offending file',
    );
  });

  it('enforceMaintainabilityFloor returns 0 when every file is above the MI floor', () => {
    const scores = {
      'lib/a.js': DEFAULT_FLOORS.maintainability + 1,
      'lib/b.js': DEFAULT_FLOORS.maintainability + 20,
    };
    assert.equal(
      enforceMaintainabilityFloor(scores, [], { floors: DEFAULT_FLOORS }),
      0,
    );
  });

  it('--floor=off lets a sub-floor file pass (baseline-snap escape hatch)', () => {
    const scores = {
      'lib/deliberately-sub-floor.js': DEFAULT_FLOORS.maintainability - 50,
    };
    assert.equal(
      enforceMaintainabilityFloor(scores, ['--floor=off'], {
        floors: DEFAULT_FLOORS,
      }),
      0,
    );
  });

  it('applyFloorPolicy flags a sub-floor coverage file (the coverage gate path)', () => {
    const { violations } = applyFloorPolicy(
      [
        {
          file: 'lib/under-covered.js',
          lines: DEFAULT_FLOORS.coverage.lines - 10,
          branches: DEFAULT_FLOORS.coverage.branches - 5,
          functions: DEFAULT_FLOORS.coverage.functions - 1,
        },
      ],
      DEFAULT_FLOORS,
      'coverage',
    );
    assert.ok(
      violations.length >= 1,
      'sub-floor coverage record must surface as a violation',
    );
    for (const v of violations) {
      assert.equal(v.scope, 'coverage');
      assert.equal(v.reason, 'below-floor');
      assert.equal(v.file, 'lib/under-covered.js');
    }
  });

  it('applyFloorPolicy flags a method above the CRAP ceiling (the crap gate path)', () => {
    const { violations } = applyFloorPolicy(
      [
        {
          file: 'lib/hot.js',
          method: 'tangled',
          score: DEFAULT_FLOORS.crap + 12,
        },
      ],
      DEFAULT_FLOORS,
      'crap',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].scope, 'crap');
    assert.equal(violations[0].reason, 'above-ceiling');
    assert.equal(violations[0].method, 'tangled');
  });
});
