import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateAutoRefresh } from '../../.agents/scripts/lib/auto-refresh-baselines.js';

/**
 * Story #1398 (Epic #1386). Unit coverage for the pure delta-cap evaluator
 * that decides whether a Story-close baseline auto-refresh is bounded
 * (`canAutoRefresh: true`) or whether it crosses the configured caps and
 * must surface a `baseline-refresh-regression` friction signal instead.
 *
 * The evaluator is pure (no I/O) — every test injects scoredRows + baseline
 * fixtures plus the canonical caps from `.agents/default-agentrc.json`
 * (`miDropCap: 1.5`, `crapJumpCap: 5`).
 */

const CAPS = Object.freeze({ miDropCap: 1.5, crapJumpCap: 5 });

describe('evaluateAutoRefresh — under-cap path', () => {
  it('returns canAutoRefresh=true when every MI drop is at or below the cap', () => {
    const scored = {
      mi: [
        { path: 'a.js', mi: 88.5 }, // drop 1.5 (== cap → under)
        { path: 'b.js', mi: 99.0 }, // drop 0.5
      ],
      crap: [],
    };
    const baseline = {
      mi: [
        { path: 'a.js', mi: 90.0 },
        { path: 'b.js', mi: 99.5 },
      ],
      crap: [],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
    assert.deepEqual(out.miOverCap, []);
    assert.deepEqual(out.crapOverCap, []);
    assert.deepEqual(out.refusalReasons, []);
  });

  it('returns canAutoRefresh=true when MI scores improved (negative drop)', () => {
    const scored = { mi: [{ path: 'a.js', mi: 95.0 }] };
    const baseline = { mi: [{ path: 'a.js', mi: 90.0 }] };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
  });

  it('returns canAutoRefresh=true when every CRAP jump is at or below the cap', () => {
    const scored = {
      crap: [
        { file: 'foo.js', method: 'doStuff', startLine: 10, crap: 12 }, // jump 5 (== cap)
        { file: 'foo.js', method: 'helper', startLine: 30, crap: 3 }, // jump 1
      ],
    };
    const baseline = {
      crap: [
        { file: 'foo.js', method: 'doStuff', startLine: 10, crap: 7 },
        { file: 'foo.js', method: 'helper', startLine: 30, crap: 2 },
      ],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
    assert.deepEqual(out.crapOverCap, []);
  });
});

describe('evaluateAutoRefresh — over-cap path', () => {
  it('returns canAutoRefresh=false naming the offending MI path/delta', () => {
    const scored = { mi: [{ path: 'big.js', mi: 80 }] };
    const baseline = { mi: [{ path: 'big.js', mi: 90 }] }; // drop 10 > 1.5
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, false);
    assert.equal(out.miOverCap.length, 1);
    assert.deepEqual(out.miOverCap[0], {
      path: 'big.js',
      baseline: 90,
      scored: 80,
      delta: 10,
    });
    assert.equal(out.refusalReasons.length, 1);
    assert.match(
      out.refusalReasons[0],
      /MI drop 10\.000 > cap 1\.5 on big\.js/,
    );
  });

  it('returns canAutoRefresh=false naming the offending CRAP file/method/delta', () => {
    const scored = {
      crap: [{ file: 'hot.js', method: 'churn', startLine: 5, crap: 20 }],
    };
    const baseline = {
      crap: [
        { file: 'hot.js', method: 'churn', startLine: 5, crap: 8 }, // jump 12 > 5
      ],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, false);
    assert.equal(out.crapOverCap.length, 1);
    assert.equal(out.crapOverCap[0].file, 'hot.js');
    assert.equal(out.crapOverCap[0].method, 'churn');
    assert.equal(out.crapOverCap[0].delta, 12);
    assert.match(
      out.refusalReasons[0],
      /CRAP jump 12\.000 > cap 5 on hot\.js::churn/,
    );
  });

  it('matches CRAP rows by closest startLine when the same method appears twice', () => {
    const scored = {
      crap: [{ file: 'm.js', method: 'fn', startLine: 50, crap: 30 }],
    };
    const baseline = {
      crap: [
        { file: 'm.js', method: 'fn', startLine: 5, crap: 1 }, // far
        { file: 'm.js', method: 'fn', startLine: 48, crap: 20 }, // close → jump 10
      ],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, false);
    assert.equal(out.crapOverCap[0].baseline, 20);
    assert.equal(out.crapOverCap[0].delta, 10);
  });
});

describe('evaluateAutoRefresh — mixed kinds', () => {
  it('aggregates MI and CRAP regressions in a single refusal', () => {
    const scored = {
      mi: [{ path: 'a.js', mi: 80 }], // drop 10
      crap: [{ file: 'b.js', method: 'fn', startLine: 1, crap: 50 }], // jump 40
    };
    const baseline = {
      mi: [{ path: 'a.js', mi: 90 }],
      crap: [{ file: 'b.js', method: 'fn', startLine: 1, crap: 10 }],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, false);
    assert.equal(out.miOverCap.length, 1);
    assert.equal(out.crapOverCap.length, 1);
    assert.equal(out.refusalReasons.length, 2);
  });

  it('passes when MI is over but CRAP is empty/under and vice versa is not the case (mixed under-cap stays clean)', () => {
    const scored = {
      mi: [{ path: 'a.js', mi: 89.5 }], // drop 0.5
      crap: [{ file: 'b.js', method: 'fn', startLine: 1, crap: 11 }], // jump 1
    };
    const baseline = {
      mi: [{ path: 'a.js', mi: 90 }],
      crap: [{ file: 'b.js', method: 'fn', startLine: 1, crap: 10 }],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
  });
});

describe('evaluateAutoRefresh — missing baseline rows', () => {
  it('treats a scored MI path with no baseline as new (never blocks)', () => {
    const scored = { mi: [{ path: 'new-file.js', mi: 50 }] };
    const baseline = { mi: [{ path: 'old.js', mi: 90 }] };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
    assert.deepEqual(out.miOverCap, []);
  });

  it('treats a scored CRAP method with no baseline as new (never blocks)', () => {
    const scored = {
      crap: [{ file: 'new.js', method: 'fresh', startLine: 1, crap: 99 }],
    };
    const baseline = { crap: [] };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
  });

  it('handles entirely empty scored / baseline inputs as canAutoRefresh=true', () => {
    const out = evaluateAutoRefresh({
      scoredRows: { mi: [], crap: [] },
      baseline: { mi: [], crap: [] },
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
    assert.deepEqual(out.refusalReasons, []);
  });

  it('handles missing top-level kinds (undefined) without throwing', () => {
    const out = evaluateAutoRefresh({
      scoredRows: {},
      baseline: {},
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
  });
});

describe('evaluateAutoRefresh — defensive guards', () => {
  it('throws when caps is missing or has non-finite numbers', () => {
    assert.throws(() => evaluateAutoRefresh({ scoredRows: {}, baseline: {} }));
    assert.throws(() =>
      evaluateAutoRefresh({
        scoredRows: {},
        baseline: {},
        caps: { miDropCap: 'x', crapJumpCap: 5 },
      }),
    );
    assert.throws(() =>
      evaluateAutoRefresh({
        scoredRows: {},
        baseline: {},
        caps: { miDropCap: 1.5, crapJumpCap: Number.NaN },
      }),
    );
  });

  it('skips malformed rows (no path / non-finite scores) without throwing', () => {
    const scored = {
      mi: [
        null,
        { path: '', mi: 80 },
        { path: 'a.js', mi: Number.NaN },
        { path: 'b.js', mi: 89.5 }, // drop 0.5 from baseline
      ],
      crap: [
        { file: '', method: 'fn', crap: 5 },
        { file: 'c.js', method: '', crap: 5 },
        { file: 'c.js', method: 'fn', crap: 'high' },
        { file: 'c.js', method: 'fn', startLine: 1, crap: 9 }, // jump 1
      ],
    };
    const baseline = {
      mi: [{ path: 'b.js', mi: 90 }],
      crap: [{ file: 'c.js', method: 'fn', startLine: 1, crap: 8 }],
    };
    const out = evaluateAutoRefresh({
      scoredRows: scored,
      baseline,
      caps: CAPS,
    });
    assert.equal(out.canAutoRefresh, true);
  });
});
