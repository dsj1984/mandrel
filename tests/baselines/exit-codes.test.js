// tests/baselines/exit-codes.test.js
//
// Story #1962 / Task #1968 — Lock the unified exit-code contract that
// `check-baselines.js` and every per-kind regression CLI in Epic #1943
// will share. The numeric precedence is the load-bearing invariant: the
// dispatcher fans out per-kind work and collapses the per-gate exit
// codes via `aggregate()`, so the test grid below covers every adjacent
// pair plus the empty-input identity.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregate,
  EXIT_CODES,
  EXIT_CONFIG,
  EXIT_FLOOR,
  EXIT_PASS,
  EXIT_REGRESSION,
  EXIT_SCHEMA,
} from '../../.agents/scripts/lib/baselines/exit-codes.js';

describe('exit-codes constants', () => {
  it('locks the canonical numeric values', () => {
    assert.equal(EXIT_PASS, 0);
    assert.equal(EXIT_FLOOR, 1);
    assert.equal(EXIT_SCHEMA, 2);
    assert.equal(EXIT_CONFIG, 3);
    assert.equal(EXIT_REGRESSION, 4);
  });

  it('exposes a frozen EXIT_CODES bundle for table-driven callers', () => {
    assert.equal(EXIT_CODES.EXIT_PASS, 0);
    assert.equal(EXIT_CODES.EXIT_FLOOR, 1);
    assert.equal(EXIT_CODES.EXIT_SCHEMA, 2);
    assert.equal(EXIT_CODES.EXIT_CONFIG, 3);
    assert.equal(EXIT_CODES.EXIT_REGRESSION, 4);
    assert.ok(Object.isFrozen(EXIT_CODES));
  });
});

describe('aggregate()', () => {
  it('returns EXIT_PASS for an empty input (acceptance: aggregate() === 0)', () => {
    assert.equal(aggregate(), EXIT_PASS);
  });

  it('returns the single input code when given exactly one', () => {
    assert.equal(aggregate(EXIT_PASS), EXIT_PASS);
    assert.equal(aggregate(EXIT_FLOOR), EXIT_FLOOR);
    assert.equal(aggregate(EXIT_SCHEMA), EXIT_SCHEMA);
    assert.equal(aggregate(EXIT_CONFIG), EXIT_CONFIG);
    assert.equal(aggregate(EXIT_REGRESSION), EXIT_REGRESSION);
  });

  it('takes the maximum across the canonical adjacency pairs', () => {
    // Each pair locks one rung of the precedence ladder. If any of these
    // flip, the dispatcher's exit-code contract has silently regressed.
    assert.equal(aggregate(EXIT_PASS, EXIT_FLOOR), EXIT_FLOOR);
    assert.equal(aggregate(EXIT_FLOOR, EXIT_SCHEMA), EXIT_SCHEMA);
    assert.equal(aggregate(EXIT_SCHEMA, EXIT_CONFIG), EXIT_CONFIG);
    assert.equal(aggregate(EXIT_CONFIG, EXIT_REGRESSION), EXIT_REGRESSION);
  });

  it('returns regression over config over schema over floor over pass', () => {
    // The full precedence stack: regression dominates everything else.
    assert.equal(
      aggregate(
        EXIT_PASS,
        EXIT_FLOOR,
        EXIT_SCHEMA,
        EXIT_CONFIG,
        EXIT_REGRESSION,
      ),
      EXIT_REGRESSION,
    );
    assert.equal(
      aggregate(EXIT_FLOOR, EXIT_SCHEMA, EXIT_CONFIG),
      EXIT_CONFIG,
    );
    assert.equal(aggregate(EXIT_FLOOR, EXIT_SCHEMA), EXIT_SCHEMA);
  });

  it('is order-independent (acceptance: aggregate(1, 4, 2) === 4)', () => {
    assert.equal(aggregate(1, 4, 2), 4);
    assert.equal(aggregate(4, 2, 1), 4);
    assert.equal(aggregate(2, 1, 4), 4);
  });

  it('returns EXIT_PASS when every input is PASS', () => {
    assert.equal(aggregate(EXIT_PASS, EXIT_PASS, EXIT_PASS), EXIT_PASS);
  });

  it('drops invalid codes so a garbage caller cannot mask a real failure', () => {
    // Strings, NaN, negatives, out-of-range numbers, undefined are all
    // ignored. A real EXIT_FLOOR amongst the noise still wins.
    assert.equal(
      aggregate('bogus', NaN, -1, 99, undefined, EXIT_FLOOR),
      EXIT_FLOOR,
    );
    // All-invalid input collapses to PASS — the caller signalled nothing.
    assert.equal(aggregate('x', null, undefined, NaN), EXIT_PASS);
  });
});
