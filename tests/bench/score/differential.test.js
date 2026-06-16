// tests/bench/score/differential.test.js
//
// Unit tier (pure logic, no I/O) for the Mandrel-vs-control differential +
// cross-scenario calibration metrics (Epic #4211, Story #4217). Exercises
// bench/score/differential.js against the binding rules in
// bench/metrics/README.md § "Real-delta rule" and § "Cross-scenario derived
// metrics":
//   - per-dimension delta with the real-delta rule (clears vs within-noise),
//   - planningFidelity incomparable when control is null,
//   - difficulty monotonicity (holds, and an explicit warning on a violation),
//   - overhead floor estimate + the ceremony-lite recommendation flag.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeDifferential,
  difficultyMonotonicity,
  overheadFloor,
  scoreCorpus,
} from '../../../bench/score/differential.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );

/**
 * Build a minimal scorecard carrying only the dimension scalars a test needs.
 * Missing dimensions default to benign values.
 */
function card({
  quality = 1,
  planningFidelity = 0.9,
  autonomy = 1,
  tokenRatio = 4,
  wallClockMs = 600000,
  totalTokens = 180000,
  dispatches = 2,
  costUsd = 1.4,
} = {}) {
  return {
    dimensions: {
      quality: { score: quality },
      planningFidelity: { score: planningFidelity },
      autonomy: { score: autonomy },
      overheadRatio: { tokenRatio },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
}

describe('computeDifferential — real-delta rule', () => {
  it('flags a delta that clears the larger noise-band spread as real', () => {
    // Mandrel quality tightly clustered near 1.0; control near 0.5. The gap
    // (~0.5) dwarfs either arm's spread ⇒ real.
    const mandrelRuns = [
      card({ quality: 1.0 }),
      card({ quality: 0.98 }),
      card({ quality: 1.0 }),
      card({ quality: 0.99 }),
    ];
    const controlRuns = [
      card({ quality: 0.5 }),
      card({ quality: 0.52 }),
      card({ quality: 0.48 }),
      card({ quality: 0.5 }),
    ];
    const diff = computeDifferential({ mandrelRuns, controlRuns });
    const q = diff.dimensions.quality;
    assert.equal(q.comparable, true);
    assert.equal(q.verdict, 'real');
    assert.equal(q.deltaIsReal, true);
    assert.ok(Math.abs(q.delta) > q.noiseFloor);
  });

  it('reports a delta within the noise-band as within-noise', () => {
    // Two heavily-overlapping clusters: centers differ by a hair, spreads are
    // wide ⇒ within noise.
    const mandrelRuns = [
      card({ quality: 0.7 }),
      card({ quality: 0.9 }),
      card({ quality: 0.6 }),
      card({ quality: 0.8 }),
    ];
    const controlRuns = [
      card({ quality: 0.68 }),
      card({ quality: 0.88 }),
      card({ quality: 0.62 }),
      card({ quality: 0.82 }),
    ];
    const q = computeDifferential({ mandrelRuns, controlRuns }).dimensions
      .quality;
    assert.equal(q.verdict, 'within-noise');
    assert.equal(q.deltaIsReal, false);
  });

  it('marks planningFidelity incomparable when control is null', () => {
    const mandrelRuns = [
      card({ planningFidelity: 0.9 }),
      card({ planningFidelity: 0.85 }),
    ];
    const controlRuns = [
      card({ planningFidelity: null }),
      card({ planningFidelity: null }),
    ];
    const pf = computeDifferential({ mandrelRuns, controlRuns }).dimensions
      .planningFidelity;
    assert.equal(pf.comparable, false);
    assert.equal(pf.verdict, 'incomparable');
    assert.equal(pf.deltaIsReal, false);
    assert.equal(pf.controlCenter, null);
  });

  it('differences each efficiency component independently', () => {
    const mandrelRuns = [
      card({ totalTokens: 180000 }),
      card({ totalTokens: 182000 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000 }),
      card({ totalTokens: 41000 }),
    ];
    const diff = computeDifferential({ mandrelRuns, controlRuns });
    assert.ok('totalTokens' in diff.efficiency);
    assert.ok('wallClockMs' in diff.efficiency);
    assert.ok('dispatches' in diff.efficiency);
    assert.ok('costUsd' in diff.efficiency);
    assert.equal(diff.efficiency.totalTokens.metric, 'efficiency.totalTokens');
    // 180k+ vs 40k tokens ⇒ a real gap.
    assert.equal(diff.efficiency.totalTokens.verdict, 'real');
  });

  it('carries the band method and arm sample sizes', () => {
    const diff = computeDifferential({
      mandrelRuns: [card(), card(), card()],
      controlRuns: [card(), card()],
      method: 'ci',
      scenario: 'crud-db',
    });
    assert.equal(diff.method, 'ci');
    assert.equal(diff.scenario, 'crud-db');
    assert.deepEqual(diff.n, { mandrel: 3, control: 2 });
  });
});

describe('difficultyMonotonicity — calibration guardrail', () => {
  // hello-world (easy): cheap + high overhead ratio.
  const helloMandrel = [
    card({ totalTokens: 180000, tokenRatio: 4.2 }),
    card({ totalTokens: 184000, tokenRatio: 4.0 }),
  ];
  // crud-db (hard): more expensive + lower overhead ratio.
  const crudMandrel = [
    card({ totalTokens: 520000, tokenRatio: 2.1 }),
    card({ totalTokens: 540000, tokenRatio: 2.0 }),
  ];

  it('holds when efficiency rises and overhead ratio falls down the ladder', () => {
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
        { scenario: 'crud-db', difficulty: 2, mandrelRuns: crudMandrel },
      ],
    });
    assert.equal(result.monotonicityHolds, true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].efficiencyRises, true);
    assert.equal(result.pairs[0].overheadFalls, true);
    // Ordered easy → hard regardless of input order.
    assert.deepEqual(
      result.ordered.map((o) => o.scenario),
      ['hello-world', 'crud-db'],
    );
  });

  it('sorts by difficulty even when cells are supplied hard-first', () => {
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'crud-db', difficulty: 2, mandrelRuns: crudMandrel },
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
      ],
    });
    assert.equal(result.monotonicityHolds, true);
    assert.deepEqual(result.pairs[0], {
      from: 'hello-world',
      to: 'crud-db',
      efficiencyRises: true,
      overheadFalls: true,
      holds: true,
      violations: [],
    });
  });

  it('flags a violation when efficiency does NOT rise', () => {
    // crud-db cheaper than hello-world ⇒ efficiency non-monotonic.
    const cheapCrud = [card({ totalTokens: 100000, tokenRatio: 2.0 })];
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
        { scenario: 'crud-db', difficulty: 2, mandrelRuns: cheapCrud },
      ],
    });
    assert.equal(result.monotonicityHolds, false);
    assert.equal(result.pairs[0].efficiencyRises, false);
    assert.ok(result.warnings.some((w) => /did not rise/.test(w)));
    assert.ok(result.warnings.every((w) => w.startsWith('[calibration]')));
  });

  it('flags a violation when overhead ratio does NOT fall', () => {
    // crud-db ratio HIGHER than hello-world ⇒ overhead non-monotonic.
    const highRatioCrud = [card({ totalTokens: 520000, tokenRatio: 5.0 })];
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
        { scenario: 'crud-db', difficulty: 2, mandrelRuns: highRatioCrud },
      ],
    });
    assert.equal(result.monotonicityHolds, false);
    assert.equal(result.pairs[0].overheadFalls, false);
    assert.ok(result.warnings.some((w) => /did not fall/.test(w)));
  });
});

describe('overheadFloor — framework finding', () => {
  it('estimates the token + USD floor as mandrel minus control on hello-world', () => {
    const mandrelRuns = [
      card({ totalTokens: 180000, costUsd: 1.4, quality: 1 }),
      card({ totalTokens: 184000, costUsd: 1.5, quality: 1 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000, costUsd: 0.3, quality: 1 }),
      card({ totalTokens: 42000, costUsd: 0.32, quality: 1 }),
    ];
    const floor = overheadFloor({ mandrelRuns, controlRuns });
    assert.equal(floor.scenario, 'hello-world');
    // median(180k,184k)=182k − median(40k,42k)=41k = 141000
    approx(floor.overheadFloorTokens, 141000);
    assert.ok(floor.overheadFloorUsd > 0);
    assert.ok(floor.tokenDiffBand !== null);
  });

  it('recommends a ceremony-lite path when the floor buys NO quality gain', () => {
    // Big token floor, identical quality ⇒ recommend ceremony-lite.
    const mandrelRuns = [
      card({ totalTokens: 180000, quality: 1 }),
      card({ totalTokens: 182000, quality: 1 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000, quality: 1 }),
      card({ totalTokens: 41000, quality: 1 }),
    ];
    const floor = overheadFloor({ mandrelRuns, controlRuns });
    assert.equal(floor.noQualityGain, true);
    assert.equal(floor.recommendCeremonyLite, true);
    approx(floor.qualityGain, 0);
  });

  it('does NOT recommend ceremony-lite when the floor buys a quality gain', () => {
    const mandrelRuns = [
      card({ totalTokens: 180000, quality: 1.0 }),
      card({ totalTokens: 182000, quality: 1.0 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000, quality: 0.4 }),
      card({ totalTokens: 41000, quality: 0.42 }),
    ];
    const floor = overheadFloor({ mandrelRuns, controlRuns });
    assert.equal(floor.noQualityGain, false);
    assert.equal(floor.recommendCeremonyLite, false);
    assert.ok(floor.qualityGain > 0.05);
  });
});

describe('scoreCorpus — top-level convenience', () => {
  it('computes per-scenario differentials plus both cross-scenario metrics', () => {
    const cells = [
      {
        scenario: 'hello-world',
        difficulty: 1,
        mandrelRuns: [
          card({ totalTokens: 180000, tokenRatio: 4.2, quality: 1 }),
        ],
        controlRuns: [card({ totalTokens: 40000, tokenRatio: 0, quality: 1 })],
      },
      {
        scenario: 'crud-db',
        difficulty: 2,
        mandrelRuns: [
          card({ totalTokens: 520000, tokenRatio: 2.0, quality: 1 }),
        ],
        controlRuns: [
          card({ totalTokens: 90000, tokenRatio: 0, quality: 0.9 }),
        ],
      },
    ];
    const result = scoreCorpus({ cells });
    assert.equal(result.perScenario.length, 2);
    assert.equal(result.difficultyMonotonicity.monotonicityHolds, true);
    assert.equal(result.overheadFloor.scenario, 'hello-world');
    approx(result.overheadFloor.overheadFloorTokens, 140000);
  });

  it('returns a null overhead floor when no hello-world cell is present', () => {
    const result = scoreCorpus({
      cells: [
        {
          scenario: 'crud-db',
          difficulty: 2,
          mandrelRuns: [card()],
          controlRuns: [card()],
        },
      ],
    });
    assert.equal(result.overheadFloor, null);
  });
});
