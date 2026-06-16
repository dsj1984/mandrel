// tests/bench/report/compare.test.js
//
// Unit tier (pure logic, no I/O) for the cross-run comparison
// (Epic #4211, Story #4218). Exercises bench/report/compare.js against the
// Story's binding acceptance item:
//   "surfaces the per-dimension deltas between two stored runs."
// Covers: per-dimension Mandrel-arm shift with the real-delta rule
// (improved / regressed / within-noise / incomparable), cohort-mismatch
// flagging, scenario presence in only one run, and the Markdown rendering.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareRuns,
  renderComparison,
} from '../../../bench/report/compare.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };

function card({
  scenario = 'hello-world',
  arm = 'mandrel',
  runId = `${scenario}-${arm}-r1`,
  quality = 1,
  planningFidelity = 0.9,
  autonomy = 1,
  tokenRatio = 4,
  wallClockMs = 600000,
  totalTokens = 180000,
  dispatches = 2,
  costUsd = 1.4,
  frameworkVersion = '1.70.0',
  model = MODEL,
  env = ENV,
} = {}) {
  return {
    schemaVersion: 1,
    runId,
    timestamp: '2026-06-16T19:42:11.000Z',
    model,
    frameworkVersion,
    env,
    scenario,
    arm,
    dimensions: {
      quality: { score: quality, frozenSuitePassRate: quality },
      planningFidelity: { score: arm === 'control' ? null : planningFidelity },
      autonomy: {
        score: autonomy,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
      },
      overheadRatio: { tokenRatio },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
}

/** A run of N mandrel hello-world cards at a given quality center. */
function run({ quality, totalTokens = 180000, fw = '1.70.0', n = 4 } = {}) {
  const cards = [];
  for (let i = 0; i < n; i += 1) {
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: `hw-m-${fw}-${i}`,
        quality: quality + (i % 2 === 0 ? 0.002 : -0.002),
        totalTokens: totalTokens + i * 100,
        frameworkVersion: fw,
      }),
    );
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'control',
        runId: `hw-c-${fw}-${i}`,
        quality: 0.5,
        totalTokens: 40000,
        tokenRatio: 0.1,
        frameworkVersion: fw,
      }),
    );
  }
  return cards;
}

describe('compareRuns — per-dimension cross-run deltas', () => {
  it('flags a real quality improvement when the candidate center clears the noise', () => {
    const baseline = run({ quality: 0.6 });
    const candidate = run({ quality: 0.95 });
    const cmp = compareRuns({ baseline, candidate });
    const hw = cmp.scenarios.find((s) => s.scenario === 'hello-world');
    const quality = hw.metrics.find((m) => m.metric === 'quality');
    assert.equal(quality.mandrel.comparable, true);
    assert.equal(quality.mandrel.verdict, 'improved');
    assert.ok(quality.mandrel.shift > 0);
    assert.ok(Math.abs(quality.mandrel.shift) > quality.mandrel.noiseFloor);
  });

  it('flags a real regression when the candidate quality center drops', () => {
    const baseline = run({ quality: 0.95 });
    const candidate = run({ quality: 0.6 });
    const cmp = compareRuns({ baseline, candidate });
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.equal(quality.mandrel.verdict, 'regressed');
    assert.ok(quality.mandrel.shift < 0);
  });

  it('treats overheadRatio as lower-is-better (a drop is an improvement)', () => {
    const baseline = [];
    const candidate = [];
    for (let i = 0; i < 4; i += 1) {
      baseline.push(
        card({ runId: `b-${i}`, tokenRatio: 4.0 + (i % 2 ? 0.01 : -0.01) }),
      );
      candidate.push(
        card({ runId: `c-${i}`, tokenRatio: 1.0 + (i % 2 ? 0.01 : -0.01) }),
      );
    }
    const cmp = compareRuns({ baseline, candidate });
    const overhead = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'overheadRatio',
    );
    assert.equal(overhead.mandrel.verdict, 'improved'); // ratio fell
    assert.ok(overhead.mandrel.shift < 0);
  });

  it('reports a hair-thin shift inside the band as within-noise', () => {
    // Wide spread, nearly-identical centers ⇒ within noise.
    const wide = (rid, fw) => [
      card({ runId: `${rid}-0`, quality: 0.4, frameworkVersion: fw }),
      card({ runId: `${rid}-1`, quality: 1.0, frameworkVersion: fw }),
      card({ runId: `${rid}-2`, quality: 0.5, frameworkVersion: fw }),
      card({ runId: `${rid}-3`, quality: 0.95, frameworkVersion: fw }),
    ];
    const cmp = compareRuns({
      baseline: wide('b', '1.70.0'),
      candidate: wide('c', '1.70.0'),
    });
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.equal(quality.mandrel.verdict, 'within-noise');
    assert.equal(quality.mandrel.shiftIsReal, false);
  });

  it('surfaces both arms’ centers for traceability', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.6 }),
      candidate: run({ quality: 0.9 }),
    });
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.ok(typeof quality.controlBaselineCenter === 'number');
    assert.ok(typeof quality.controlCandidateCenter === 'number');
  });

  it('includes every comparable metric (4 dimensions + 4 efficiency components)', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9 }),
      candidate: run({ quality: 0.9 }),
    });
    const metricNames = cmp.scenarios[0].metrics.map((m) => m.metric);
    assert.equal(metricNames.length, 8);
    assert.ok(metricNames.includes('quality'));
    assert.ok(metricNames.includes('efficiency.totalTokens'));
    assert.ok(metricNames.includes('efficiency.costUsd'));
  });
});

describe('compareRuns — cohort safety', () => {
  it('matches cohorts when both runs share one (model, fw, env)', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0' }),
      candidate: run({ quality: 0.9, fw: '1.70.0' }),
    });
    assert.equal(cmp.cohortMatch, true);
    assert.equal(cmp.cohortMismatchWarning, undefined);
  });

  it('flags (does not throw on) a cross-cohort comparison', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0' }),
      candidate: run({ quality: 0.9, fw: '1.71.0' }),
    });
    assert.equal(cmp.cohortMatch, false);
    assert.match(cmp.cohortMismatchWarning, /not strictly like-to-like/);
  });

  it('throws on non-array inputs', () => {
    assert.throws(
      () => compareRuns({ baseline: null, candidate: [] }),
      TypeError,
    );
  });
});

describe('compareRuns — scenario presence', () => {
  it('marks a scenario present in only one run as not cross-comparable', () => {
    const baseline = run({ quality: 0.9 }); // hello-world only
    const candidate = [
      ...run({ quality: 0.9 }),
      card({
        scenario: 'crud-db',
        arm: 'mandrel',
        runId: 'crud-m',
        quality: 0.8,
      }),
    ];
    const cmp = compareRuns({ baseline, candidate });
    const crud = cmp.scenarios.find((s) => s.scenario === 'crud-db');
    assert.equal(crud.inBaseline, false);
    assert.equal(crud.inCandidate, true);
  });
});

describe('renderComparison — Markdown', () => {
  it('renders the cohort line and a per-scenario delta table', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.6 }),
      candidate: run({ quality: 0.95 }),
    });
    const md = renderComparison(cmp, {
      baselineLabel: 'v1.70.0',
      candidateLabel: 'v1.71.0',
    });
    assert.match(md, /Cross-run comparison/);
    assert.match(md, /v1\.70\.0/);
    assert.match(md, /v1\.71\.0/);
    assert.match(md, /Scenario: `hello-world`/);
    assert.match(md, /improved/);
    assert.match(md, /Cohort:.*matched/);
  });

  it('renders the cohort-mismatch warning in the Markdown', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0' }),
      candidate: run({ quality: 0.9, fw: '1.71.0' }),
    });
    const md = renderComparison(cmp);
    assert.match(md, /Cohort mismatch/);
  });

  it('is deterministic', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.6 }),
      candidate: run({ quality: 0.95 }),
    });
    assert.equal(renderComparison(cmp), renderComparison(cmp));
  });
});
