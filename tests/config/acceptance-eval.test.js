// tests/config/acceptance-eval.test.js
//
// Unit-tier coverage for the `delivery.acceptanceEval` config accessor
// (Story #3819). Asserts the documented default, and — critically — the
// undisableable hard cap: no configured value can disable the loop
// (`maxRounds: 0` clamps up to 1) or let it spin unbounded (`maxRounds`
// above the ceiling clamps down).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCEPTANCE_EVAL_DEFAULTS,
  ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING,
  getAcceptanceEval,
} from '../../.agents/scripts/lib/config/acceptance-eval.js';

describe('getAcceptanceEval — defaults', () => {
  it('resolves the documented default when the block is absent', () => {
    const out = getAcceptanceEval({});
    assert.equal(out.maxRounds, ACCEPTANCE_EVAL_DEFAULTS.maxRounds);
    assert.equal(out.maxRounds, 2);
    assert.equal(out.ceiling, ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING);
  });

  it('resolves the default when config / delivery are null or undefined', () => {
    for (const config of [
      null,
      undefined,
      { delivery: null },
      { delivery: {} },
    ]) {
      const out = getAcceptanceEval(config);
      assert.equal(out.maxRounds, 2);
    }
  });

  it('honours an in-range operator override', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { maxRounds: 3 } },
    });
    assert.equal(out.maxRounds, 3);
  });
});

describe('getAcceptanceEval — undisableable cap (open-loop guard)', () => {
  it('clamps maxRounds: 0 up to 1 (the loop cannot be disabled)', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { maxRounds: 0 } },
    });
    assert.equal(out.maxRounds, 1);
  });

  it('clamps a negative maxRounds up to 1', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { maxRounds: -5 } },
    });
    assert.equal(out.maxRounds, 1);
  });

  it('clamps an over-ceiling maxRounds down to the hard ceiling', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { maxRounds: 9999 } },
    });
    assert.equal(out.maxRounds, ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING);
  });

  it('falls back to the default for non-integer / non-finite values', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      const out = getAcceptanceEval({
        delivery: { acceptanceEval: { maxRounds: bad } },
      });
      assert.equal(
        out.maxRounds,
        2,
        `value ${String(bad)} should fall back to default`,
      );
    }
  });

  it('never returns a maxRounds outside [1, ceiling] for any numeric input', () => {
    for (let v = -3; v <= ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING + 5; v += 1) {
      const out = getAcceptanceEval({
        delivery: { acceptanceEval: { maxRounds: v } },
      });
      assert.ok(out.maxRounds >= 1, `maxRounds ${out.maxRounds} must be >= 1`);
      assert.ok(
        out.maxRounds <= ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING,
        `maxRounds ${out.maxRounds} must be <= ceiling`,
      );
    }
  });

  it('freezes the defaults object so callers cannot mutate it cross-process', () => {
    assert.equal(Object.isFrozen(ACCEPTANCE_EVAL_DEFAULTS), true);
  });
});
