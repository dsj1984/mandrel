// tests/bench/score/dimensions.test.js
//
// Unit tier (pure logic, no I/O) for the five-dimension scorer
// (Epic #4211, Story #4217). Exercises bench/score/dimensions.js against the
// verbatim formulas in bench/metrics/README.md § "The five dimensions":
// quality, planningFidelity, autonomy, efficiency, overheadRatio — plus the
// control-arm null behaviour and the divide-by-zero / no-codegen edges.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeAutonomy,
  computeDimensions,
  computeEfficiency,
  computeOverheadRatio,
  computePlanningFidelity,
  computeQuality,
  fileFootprintDrift,
  QUALITY_WEIGHTS,
} from '../../../bench/score/dimensions.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );

describe('computeQuality', () => {
  it('blends frozen-suite pass rate (0.7) and judge score (0.3)', () => {
    const q = computeQuality({
      frozenSuitePassed: 6,
      frozenSuiteTotal: 6,
      acceptanceEvalScore: 0.5,
    });
    approx(q.frozenSuitePassRate, 1);
    // 0.7*1 + 0.3*0.5 = 0.85
    approx(q.score, QUALITY_WEIGHTS.suite * 1 + QUALITY_WEIGHTS.judge * 0.5);
    assert.equal(q.frozenSuitePassed, 6);
    assert.equal(q.frozenSuiteTotal, 6);
    assert.equal(q.acceptanceEvalScore, 0.5);
  });

  it('folds judge weight onto the suite when acceptanceEvalScore is null', () => {
    const q = computeQuality({
      frozenSuitePassed: 3,
      frozenSuiteTotal: 4,
      acceptanceEvalScore: null,
    });
    approx(q.frozenSuitePassRate, 0.75);
    // judge null ⇒ score === pass rate (w_suite renormalized to 1.0)
    approx(q.score, 0.75);
    assert.equal(q.acceptanceEvalScore, null);
  });

  it('treats a missing judge score the same as null', () => {
    const q = computeQuality({ frozenSuitePassed: 1, frozenSuiteTotal: 2 });
    approx(q.score, 0.5);
    assert.equal(q.acceptanceEvalScore, null);
  });

  it('scores a delivered-but-empty suite (total 0) as 0, not NaN', () => {
    const q = computeQuality({ frozenSuitePassed: 0, frozenSuiteTotal: 0 });
    approx(q.frozenSuitePassRate, 0);
    approx(q.score, 0);
  });

  it('a run that fails every assertion scores 0', () => {
    const q = computeQuality({
      frozenSuitePassed: 0,
      frozenSuiteTotal: 6,
      acceptanceEvalScore: 0,
    });
    approx(q.score, 0);
  });

  it('clamps an out-of-range judge score into [0,1]', () => {
    const q = computeQuality({
      frozenSuitePassed: 2,
      frozenSuiteTotal: 2,
      acceptanceEvalScore: 5,
    });
    assert.ok(q.acceptanceEvalScore <= 1 && q.acceptanceEvalScore >= 0);
    assert.ok(q.score <= 1);
  });
});

describe('fileFootprintDrift', () => {
  it('is 0 for identical path sets', () => {
    approx(fileFootprintDrift(['a', 'b'], ['a', 'b']), 0);
  });

  it('is 1 for disjoint path sets', () => {
    approx(fileFootprintDrift(['a'], ['b']), 1);
  });

  it('is the Jaccard distance for partial overlap', () => {
    // P={a,b,c} A={b,c,d} ∩=2 ∪=4 ⇒ 1 − 2/4 = 0.5
    approx(fileFootprintDrift(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  });

  it('is 0 when both sets are empty', () => {
    approx(fileFootprintDrift([], []), 0);
  });
});

describe('computePlanningFidelity', () => {
  it('averages story accuracy, re-plan penalty, and footprint accuracy', () => {
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      rePlanCount: 0,
      plannedStoryCount: 2,
      deliveredStoryCount: 2,
      fileFootprintDrift: 0,
    });
    // storyAccuracy=1, rePlanPenalty=1, footprintAccuracy=1 ⇒ 1
    approx(pf.score, 1);
  });

  it('penalizes re-plans and story-count drift', () => {
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      rePlanCount: 1, // penalty = 1/2
      plannedStoryCount: 2,
      deliveredStoryCount: 4, // accuracy = 1 - 2/4 = 0.5
      fileFootprintDrift: 0.25, // footprintAccuracy = 0.75
    });
    approx(pf.score, (0.5 + 0.5 + 0.75) / 3);
  });

  it('derives footprint drift from planned/actual paths when not supplied', () => {
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      rePlanCount: 0,
      plannedStoryCount: 1,
      deliveredStoryCount: 1,
      plannedPaths: ['a', 'b'],
      actualPaths: ['b', 'c'], // ∩=1 ∪=3 ⇒ drift 2/3, footprintAccuracy 1/3
    });
    approx(pf.fileFootprintDrift, 2 / 3);
    approx(pf.score, (1 + 1 + 1 / 3) / 3);
  });

  it('is null for the control arm (no plan authored)', () => {
    const pf = computePlanningFidelity({
      arm: 'control',
      plannedStoryCount: 0,
      deliveredStoryCount: 1,
    });
    assert.equal(pf.score, null);
    // sub-signals still reported for shape stability
    assert.equal(pf.deliveredStoryCount, 1);
  });

  it('honours an explicit planAuthored:false override', () => {
    const pf = computePlanningFidelity({ planAuthored: false });
    assert.equal(pf.score, null);
  });
});

describe('computeAutonomy', () => {
  it('is 1.0 for a fully unattended run', () => {
    const a = computeAutonomy({
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
    });
    approx(a.score, 1);
  });

  it('collapses interventions via 1/(1+interventions)', () => {
    const a = computeAutonomy({
      hitlStops: 1,
      blockedEvents: 1,
      manualRescues: 1,
    });
    // interventions = 3 ⇒ 1/4
    approx(a.score, 0.25);
  });

  it('coerces malformed counters to 0', () => {
    const a = computeAutonomy({
      hitlStops: -3,
      blockedEvents: 'x',
      manualRescues: 2.9,
    });
    // -3→0, 'x'→0, 2.9→2 ⇒ interventions 2 ⇒ 1/3
    approx(a.score, 1 / 3);
  });
});

describe('computeEfficiency', () => {
  it('reports the vector and preserves a reported costUsd', () => {
    const e = computeEfficiency({
      wallClockMs: 612000,
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      dispatches: 2,
      costUsd: 1.47,
    });
    assert.deepEqual(e, {
      wallClockMs: 612000,
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      dispatches: 2,
      costUsd: 1.47,
    });
  });

  it('coerces a missing/negative costUsd to null', () => {
    assert.equal(computeEfficiency({ costUsd: -1 }).costUsd, null);
    assert.equal(computeEfficiency({}).costUsd, null);
  });
});

describe('computeOverheadRatio', () => {
  it('is ceremonyTokens / codegenTokens', () => {
    const o = computeOverheadRatio({
      ceremonyTokens: 148800,
      codegenTokens: 35520,
    });
    approx(o.tokenRatio, 148800 / 35520);
    assert.equal(o.timeRatio, null);
  });

  it('computes timeRatio when both ms values are present', () => {
    const o = computeOverheadRatio({
      ceremonyTokens: 4,
      codegenTokens: 1,
      ceremonyMs: 360,
      codegenMs: 100,
    });
    approx(o.timeRatio, 3.6);
  });

  it('reports 0 (not Infinity) when no codegen tokens were recorded', () => {
    const o = computeOverheadRatio({ ceremonyTokens: 1000, codegenTokens: 0 });
    approx(o.tokenRatio, 0);
  });

  it('control-arm-like input (near-zero ceremony) sits near the floor', () => {
    const o = computeOverheadRatio({ ceremonyTokens: 0, codegenTokens: 5000 });
    approx(o.tokenRatio, 0);
  });
});

describe('computeDimensions', () => {
  it('produces all five dimensions with the canonical keys', () => {
    const dims = computeDimensions({
      arm: 'mandrel',
      frozenSuitePassed: 6,
      frozenSuiteTotal: 6,
      acceptanceEvalScore: 1,
      rePlanCount: 0,
      plannedStoryCount: 2,
      deliveredStoryCount: 2,
      fileFootprintDrift: 0.08,
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
      wallClockMs: 612000,
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      dispatches: 2,
      costUsd: 1.47,
      ceremonyTokens: 148800,
      codegenTokens: 35520,
    });
    assert.deepEqual(Object.keys(dims).sort(), [
      'autonomy',
      'efficiency',
      'overheadRatio',
      'planningFidelity',
      'quality',
    ]);
    approx(dims.quality.score, 1);
    approx(dims.autonomy.score, 1);
    assert.equal(typeof dims.planningFidelity.score, 'number');
  });

  it('nulls planningFidelity when arm is control', () => {
    const dims = computeDimensions({
      arm: 'control',
      frozenSuitePassed: 6,
      frozenSuiteTotal: 6,
      ceremonyTokens: 0,
      codegenTokens: 5000,
    });
    assert.equal(dims.planningFidelity.score, null);
    // control quality with no judge folds onto the frozen suite
    approx(dims.quality.score, 1);
  });
});
