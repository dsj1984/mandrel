import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateRowSamples,
  DEFAULT_RUNS,
  describeSamples,
  MAX_RUNS,
  parseArgv,
  recommendThresholds,
  renderCsv,
  renderMarkdownReport,
  summarizeRows,
} from '../.agents/scripts/noise-study.js';

/**
 * Unit tests for noise-study aggregation. Deterministic fixtures only —
 * the CLI never spawns a child process here. The contract being pinned is
 * the math: mean / stddev / p95 abs-dev / recommendation rounding /
 * accumulator merge / row-sort stability.
 */

test('parseArgv — defaults', () => {
  const out = parseArgv([]);
  assert.equal(out.runs, DEFAULT_RUNS);
  assert.equal(out.outPath, null);
  assert.equal(out.skipCoverage, false);
  assert.equal(out.targetDirs, null);
});

test('parseArgv — explicit flags', () => {
  const out = parseArgv([
    '--runs',
    '7',
    '--out',
    'docs/noise.md',
    '--skip-coverage',
    '--target-dirs',
    'src,tests',
  ]);
  assert.equal(out.runs, 7);
  assert.equal(out.outPath, 'docs/noise.md');
  assert.equal(out.skipCoverage, true);
  assert.deepEqual(out.targetDirs, ['src', 'tests']);
});

test('parseArgv — runs capped at MAX_RUNS', () => {
  const out = parseArgv(['--runs', String(MAX_RUNS + 50)]);
  assert.equal(out.runs, MAX_RUNS);
});

test('parseArgv — malformed --runs falls back to default', () => {
  const out = parseArgv(['--runs', 'banana']);
  assert.equal(out.runs, DEFAULT_RUNS);
});

test('describeSamples — empty', () => {
  const s = describeSamples([]);
  assert.deepEqual(s, {
    mean: 0,
    stddev: 0,
    p95AbsDev: 0,
    min: 0,
    max: 0,
    n: 0,
  });
});

test('describeSamples — single sample has zero stddev/p95', () => {
  const s = describeSamples([42]);
  assert.equal(s.n, 1);
  assert.equal(s.mean, 42);
  assert.equal(s.stddev, 0);
  assert.equal(s.p95AbsDev, 0);
  assert.equal(s.min, 42);
  assert.equal(s.max, 42);
});

test('describeSamples — constant samples have zero noise', () => {
  const s = describeSamples([5, 5, 5, 5, 5]);
  assert.equal(s.mean, 5);
  assert.equal(s.stddev, 0);
  assert.equal(s.p95AbsDev, 0);
  assert.equal(s.min, 5);
  assert.equal(s.max, 5);
});

test('describeSamples — known stddev fixture', () => {
  // [2,4,4,4,5,5,7,9] — mean 5, population variance 4, stddev 2.
  const s = describeSamples([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.mean, 5);
  assert.equal(s.stddev, 2);
  assert.equal(s.min, 2);
  assert.equal(s.max, 9);
});

test('describeSamples — p95 abs-dev uses linear interpolation', () => {
  // [10, 10, 10, 10, 11] — mean 10.2, abs-devs [0.2,0.2,0.2,0.2,0.8].
  // sorted: [0.2,0.2,0.2,0.2,0.8]. idx=0.95*4=3.8 → lo=3 (0.2), hi=4 (0.8),
  // p95 = 0.2 + 0.8*(0.8-0.2) = 0.68.
  const s = describeSamples([10, 10, 10, 10, 11]);
  assert.ok(Math.abs(s.p95AbsDev - 0.68) < 1e-9, `got ${s.p95AbsDev}`);
});

test('accumulateRowSamples — merges across runs by key', () => {
  const acc = new Map();
  const run1 = [
    { file: 'a.js', score: 70 },
    { file: 'b.js', score: 80 },
  ];
  const run2 = [
    { file: 'a.js', score: 71 },
    { file: 'b.js', score: 79 },
  ];
  accumulateRowSamples(
    acc,
    run1,
    (r) => r.file,
    (r) => r.score,
  );
  accumulateRowSamples(
    acc,
    run2,
    (r) => r.file,
    (r) => r.score,
  );
  assert.deepEqual(acc.get('a.js').samples, [70, 71]);
  assert.deepEqual(acc.get('b.js').samples, [80, 79]);
});

test('accumulateRowSamples — drops non-finite scores', () => {
  const acc = new Map();
  accumulateRowSamples(
    acc,
    [
      { file: 'a.js', score: 70 },
      { file: 'b.js', score: Number.NaN },
      { file: 'c.js', score: Infinity },
      { file: 'd.js', score: 42 },
    ],
    (r) => r.file,
    (r) => r.score,
  );
  assert.equal(acc.size, 2);
  assert.ok(acc.has('a.js'));
  assert.ok(acc.has('d.js'));
});

test('summarizeRows — sorted by descending p95 abs-dev', () => {
  const acc = new Map([
    ['quiet.js', { samples: [10, 10, 10, 10, 10], meta: { file: 'quiet.js' } }],
    [
      'noisy.js',
      { samples: [10, 11, 9, 12, 8, 11, 9], meta: { file: 'noisy.js' } },
    ],
    ['mid.js', { samples: [5, 5.1, 4.9, 5.05], meta: { file: 'mid.js' } }],
  ]);
  const summary = summarizeRows(acc);
  assert.equal(summary.length, 3);
  assert.equal(summary[0].key, 'noisy.js');
  // Quiet row sits at the bottom — zero abs-dev.
  assert.equal(summary[2].key, 'quiet.js');
  assert.equal(summary[2].p95AbsDev, 0);
});

test('recommendThresholds — empty summary returns zero', () => {
  const r = recommendThresholds([]);
  assert.deepEqual(r, { raw: 0, recommended: 0, sampleCount: 0 });
});

test('recommendThresholds — picks across-row p95 and rounds up to 2dp', () => {
  const summary = [
    { p95AbsDev: 0.001 },
    { p95AbsDev: 0.01 },
    { p95AbsDev: 0.05 },
    { p95AbsDev: 0.1 },
    { p95AbsDev: 0.2 },
    { p95AbsDev: 0.3 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.61 },
    { p95AbsDev: 0.7 },
    { p95AbsDev: 1.5 },
  ];
  const r = recommendThresholds(summary);
  // sorted xs has n=10. idx=0.95*9=8.55 → lo=8 (0.7), hi=9 (1.5),
  // raw = 0.7 + 0.55*(1.5-0.7) = 0.7 + 0.44 = 1.14
  assert.ok(Math.abs(r.raw - 1.14) < 1e-9);
  assert.equal(r.recommended, 1.14);
  assert.equal(r.sampleCount, 10);
});

test('recommendThresholds — safetyMultiplier widens', () => {
  const summary = Array.from({ length: 20 }, (_, i) => ({
    p95AbsDev: 0.1 + i * 0.01,
  }));
  const base = recommendThresholds(summary, 1.0);
  const widened = recommendThresholds(summary, 1.5);
  // raw is the unweighted across-row p95 — invariant under safetyMultiplier.
  assert.equal(widened.raw, base.raw);
  // recommended is widened.
  assert.ok(widened.recommended > base.recommended);
});

test('recommendThresholds — rounds up so recommendation always covers raw', () => {
  const summary = [
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.5 },
    { p95AbsDev: 0.501 },
  ];
  const r = recommendThresholds(summary);
  // Across-row p95 lands very near 0.501; recommendation must be ≥ raw.
  assert.ok(r.recommended >= r.raw);
});

test('renderMarkdownReport — emits expected sections', () => {
  const miSummary = [
    {
      key: 'src/a.js',
      meta: { file: 'src/a.js' },
      mean: 70,
      stddev: 0.5,
      p95AbsDev: 0.3,
      min: 69,
      max: 71,
      n: 5,
    },
  ];
  const crapSummary = [
    {
      key: 'src/a.js::foo@10',
      meta: {},
      mean: 4,
      stddev: 0.1,
      p95AbsDev: 0.05,
      min: 3.9,
      max: 4.1,
      n: 5,
    },
  ];
  const body = renderMarkdownReport({
    runs: 5,
    runnerOs: 'linux',
    nodeVersion: 'v22.0.0',
    gitRef: 'deadbeef',
    capturedAt: '2026-05-11T00:00:00.000Z',
    miSummary,
    crapSummary,
    miRecommendation: { raw: 0.3, recommended: 0.3, sampleCount: 1 },
    crapRecommendation: { raw: 0.05, recommended: 0.05, sampleCount: 1 },
  });
  assert.match(body, /# Noise study —/);
  assert.match(body, /## Run metadata/);
  assert.match(body, /## Recommended thresholds/);
  assert.match(body, /## Top \d+ noisiest MI rows/);
  assert.match(body, /## Top \d+ noisiest CRAP rows/);
  assert.match(body, /`src\/a\.js`/);
  assert.match(body, /`src\/a\.js::foo@10`/);
  // Recommended-threshold block carries the JSON for paste.
  assert.match(body, /"tolerance": 0\.30/);
});

test('renderMarkdownReport — empty rows section', () => {
  const body = renderMarkdownReport({
    runs: 0,
    runnerOs: 'linux',
    nodeVersion: 'v22.0.0',
    gitRef: '(unknown)',
    capturedAt: '2026-05-11T00:00:00.000Z',
    miSummary: [],
    crapSummary: [],
    miRecommendation: { raw: 0, recommended: 0, sampleCount: 0 },
    crapRecommendation: { raw: 0, recommended: 0, sampleCount: 0 },
  });
  assert.match(body, /\(no MI rows captured\)/);
  assert.match(body, /\(no CRAP rows captured\)/);
});

test('renderCsv — header + one MI + one CRAP row', () => {
  const miSummary = [
    {
      key: 'src/a.js',
      n: 2,
      mean: 70,
      stddev: 0.5,
      p95AbsDev: 0.3,
      min: 69,
      max: 71,
    },
  ];
  const crapSummary = [
    {
      key: 'src/b.js::foo@1',
      n: 2,
      mean: 4,
      stddev: 0.1,
      p95AbsDev: 0.05,
      min: 3.9,
      max: 4.1,
    },
  ];
  const miAcc = new Map([['src/a.js', { samples: [70, 71] }]]);
  const crapAcc = new Map([['src/b.js::foo@1', { samples: [3.9, 4.1] }]]);
  const csv = renderCsv(miSummary, crapSummary, miAcc, crapAcc);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'gate,key,n,mean,stddev,p95AbsDev,min,max,samples');
  assert.match(lines[1], /^mi,/);
  assert.match(lines[2], /^crap,/);
});
