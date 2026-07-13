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
  ACCEPTANCE_EVAL_CLUSTER_CEILING_MAX,
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

describe('getAcceptanceEval — clusterCeiling (single-delivery dilution guard)', () => {
  it('defaults to 4 when the block is absent', () => {
    const out = getAcceptanceEval({});
    assert.equal(out.clusterCeiling, 4);
    assert.equal(out.clusterCeiling, ACCEPTANCE_EVAL_DEFAULTS.clusterCeiling);
    assert.equal(out.clusterCeilingMax, ACCEPTANCE_EVAL_CLUSTER_CEILING_MAX);
    assert.equal(out.clusterCeilingMax, 8);
  });

  it('honours an in-range operator override', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { clusterCeiling: 3 } },
    });
    assert.equal(out.clusterCeiling, 3);
  });

  it('clamps clusterCeiling: 0 / negative up to 1 (never a zero-size cluster)', () => {
    assert.equal(
      getAcceptanceEval({ delivery: { acceptanceEval: { clusterCeiling: 0 } } })
        .clusterCeiling,
      1,
    );
    assert.equal(
      getAcceptanceEval({
        delivery: { acceptanceEval: { clusterCeiling: -4 } },
      }).clusterCeiling,
      1,
    );
  });

  it('clamps an over-max clusterCeiling down to the hard cap (anti-dilution)', () => {
    const out = getAcceptanceEval({
      delivery: { acceptanceEval: { clusterCeiling: 999 } },
    });
    assert.equal(out.clusterCeiling, ACCEPTANCE_EVAL_CLUSTER_CEILING_MAX);
  });

  it('falls back to the default for non-integer / non-finite values', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
      const out = getAcceptanceEval({
        delivery: { acceptanceEval: { clusterCeiling: bad } },
      });
      assert.equal(out.clusterCeiling, 4, `value ${String(bad)} → default`);
    }
  });

  it('never returns a clusterCeiling outside [1, max] for any numeric input', () => {
    for (let v = -3; v <= ACCEPTANCE_EVAL_CLUSTER_CEILING_MAX + 5; v += 1) {
      const { clusterCeiling } = getAcceptanceEval({
        delivery: { acceptanceEval: { clusterCeiling: v } },
      });
      assert.ok(clusterCeiling >= 1);
      assert.ok(clusterCeiling <= ACCEPTANCE_EVAL_CLUSTER_CEILING_MAX);
    }
  });
});
