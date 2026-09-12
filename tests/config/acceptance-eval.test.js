// tests/config/acceptance-eval.test.js
//
// Unit-tier coverage for the `delivery.acceptanceEval` config accessor
// (Story #3819; Story #5313 dropped the hard ceiling and the floor-of-one
// clamp). Asserts the documented default, that `maxRounds: 0` is honoured
// as "score once, no redraft round", and that malformed values fall back to
// the default rather than to a clamp.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCEPTANCE_EVAL_DEFAULTS,
  getAcceptanceEval,
} from '../../.agents/scripts/lib/config/acceptance-eval.js';

describe('getAcceptanceEval — defaults', () => {
  it('resolves the documented default when the block is absent', () => {
    const out = getAcceptanceEval({});
    assert.equal(out.maxRounds, ACCEPTANCE_EVAL_DEFAULTS.maxRounds);
    assert.equal(out.maxRounds, 2);
    assert.equal('ceiling' in out, false, 'the hard ceiling is retired');
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

  it('honours an operator override, with no upper clamp', () => {
    assert.equal(
      getAcceptanceEval({ delivery: { acceptanceEval: { maxRounds: 3 } } })
        .maxRounds,
      3,
    );
    assert.equal(
      getAcceptanceEval({ delivery: { acceptanceEval: { maxRounds: 9 } } })
        .maxRounds,
      9,
    );
  });
});

describe('getAcceptanceEval — maxRounds: 0 means scored once (Story #5313)', () => {
  it('AC-1: resolves 0 to zero redraft rounds instead of clamping up to 1', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { maxRounds: 0 } },
    });
    assert.equal(out.maxRounds, 0);
  });

  it('falls back to the default for negative, non-integer or non-finite values', () => {
    for (const bad of [
      -5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '3',
      null,
    ]) {
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

  it('freezes the defaults object so callers cannot mutate it cross-process', () => {
    assert.equal(Object.isFrozen(ACCEPTANCE_EVAL_DEFAULTS), true);
  });
});
