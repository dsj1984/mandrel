// tests/bench/report/render.test.js
//
// Unit tier (pure logic, no I/O) for the value-add report renderer
// (Epic #4211, Story #4218). Exercises bench/report/render.js against the
// Story's binding acceptance items:
//   - every dimension rendered as a distribution (a noise-band per arm),
//   - the Mandrel-vs-bare delta and the noise-band verdict,
//   - the per-difficulty scaling view (Efficiency + Overhead ratio, both arms),
//   - monotonicity violations surfaced as explicit calibration warnings,
//   - the overhead-floor estimate surfaced in Recommended improvements,
//   - a clearly-delineated, actionable, evidence-linked Recommended
//     improvements section.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReportModel,
  deriveCohort,
  dimensionRows,
  groupCells,
  recommendImprovements,
  renderReport,
  renderScalingView,
} from '../../../bench/report/render.js';
import { scoreCorpus } from '../../../bench/score/differential.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const FW = '1.70.0';

/**
 * Build a full per-run scorecard carrying the stamp + the dimension scalars a
 * test cares about. Defaults are benign and in-range.
 */
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
  model = MODEL,
  frameworkVersion = FW,
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

/**
 * A small but realistic corpus: two scenarios × two arms × a few runs each,
 * shaped so monotonicity HOLDS (tokens rise, overhead ratio falls easy→hard)
 * and Mandrel clearly beats control on quality.
 */
function healthyCorpus() {
  const cards = [];
  // hello-world: low tokens, high overhead ratio.
  for (let i = 0; i < 4; i += 1) {
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: `hw-m-${i}`,
        quality: 1 - i * 0.005,
        tokenRatio: 4.2,
        totalTokens: 180000 + i * 1000,
        costUsd: 1.4,
      }),
    );
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'control',
        runId: `hw-c-${i}`,
        quality: 0.5 + i * 0.005,
        tokenRatio: 0.1,
        totalTokens: 40000 + i * 500,
        costUsd: 0.3,
      }),
    );
  }
  // crud-db: higher tokens, lower overhead ratio (amortized).
  for (let i = 0; i < 4; i += 1) {
    cards.push(
      card({
        scenario: 'crud-db',
        arm: 'mandrel',
        runId: `crud-m-${i}`,
        quality: 0.95 - i * 0.005,
        tokenRatio: 1.5,
        totalTokens: 900000 + i * 5000,
        costUsd: 7.0,
      }),
    );
    cards.push(
      card({
        scenario: 'crud-db',
        arm: 'control',
        runId: `crud-c-${i}`,
        quality: 0.4 + i * 0.005,
        tokenRatio: 0.1,
        totalTokens: 300000 + i * 2000,
        costUsd: 2.5,
      }),
    );
  }
  return cards;
}

describe('groupCells', () => {
  it('groups by scenario and arm, ordered by the difficulty ladder', () => {
    const cells = groupCells(healthyCorpus());
    assert.equal(cells.length, 2);
    assert.equal(cells[0].scenario, 'hello-world'); // difficulty 1 first
    assert.equal(cells[1].scenario, 'crud-db'); // difficulty 2 second
    assert.equal(cells[0].mandrelRuns.length, 4);
    assert.equal(cells[0].controlRuns.length, 4);
  });

  it('sorts an unknown scenario last without dropping it', () => {
    const cells = groupCells([
      card({ scenario: 'crud-db', runId: 'a' }),
      card({ scenario: 'mystery', runId: 'b' }),
      card({ scenario: 'hello-world', runId: 'c' }),
    ]);
    assert.deepEqual(
      cells.map((c) => c.scenario),
      ['hello-world', 'crud-db', 'mystery'],
    );
  });

  it('throws on a non-array input', () => {
    assert.throws(() => groupCells(null), TypeError);
  });
});

describe('deriveCohort', () => {
  it('collects the distinct stamp values and flags a single cohort as not mixed', () => {
    const cohort = deriveCohort(healthyCorpus());
    assert.deepEqual(cohort.models, ['claude-opus-4-8[1m]']);
    assert.deepEqual(cohort.frameworkVersions, ['1.70.0']);
    assert.equal(cohort.mixed, false);
  });

  it('flags a mixed cohort when stamps diverge', () => {
    const cohort = deriveCohort([
      card({ runId: 'a', frameworkVersion: '1.70.0' }),
      card({ runId: 'b', frameworkVersion: '1.71.0' }),
    ]);
    assert.equal(cohort.mixed, true);
    assert.equal(cohort.frameworkVersions.length, 2);
  });
});

describe('dimensionRows — distributions per arm + delta verdict', () => {
  it('reports a noise-band for both arms on every dimension (no bare points)', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const rows = dimensionRows(cells[0], corpus.perScenario[0], 'iqr');
    // 4 scalar dimensions + 4 efficiency components = 8 rows.
    assert.equal(rows.length, 8);
    const quality = rows.find((r) => r.metric === 'quality');
    // Both arms have a band (a distribution), not a single number.
    assert.ok(
      quality.mandrelBand && typeof quality.mandrelBand.center === 'number',
    );
    assert.ok(
      quality.controlBand && typeof quality.controlBand.center === 'number',
    );
    assert.ok('low' in quality.mandrelBand && 'high' in quality.mandrelBand);
  });

  it('flags the Mandrel-vs-control quality gap as a real delta', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const rows = dimensionRows(cells[0], corpus.perScenario[0], 'iqr');
    const quality = rows.find((r) => r.metric === 'quality');
    assert.equal(quality.verdict, 'real');
    assert.ok(quality.delta > 0); // mandrel − control, mandrel higher
  });

  it('marks planningFidelity incomparable when the control arm is null', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const rows = dimensionRows(cells[0], corpus.perScenario[0], 'iqr');
    const pf = rows.find((r) => r.metric === 'planningFidelity');
    assert.equal(pf.verdict, 'incomparable');
    assert.equal(pf.controlBand, null); // control authored no plan
    assert.ok(pf.mandrelBand); // mandrel still has a distribution
  });
});

describe('renderScalingView — per-difficulty ladder', () => {
  it('renders Efficiency + Overhead ratio across the ladder for both arms', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const md = renderScalingView(cells, corpus, 'iqr');
    assert.match(md, /Per-difficulty scaling view/);
    assert.match(md, /Tokens \(mandrel\)/);
    assert.match(md, /Tokens \(control\)/);
    assert.match(md, /Overhead ratio \(mandrel\)/);
    assert.match(md, /Overhead ratio \(control\)/);
    // Both rungs present.
    assert.match(md, /hello-world/);
    assert.match(md, /crud-db/);
  });

  it('reports monotonicity holding on a healthy corpus', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const md = renderScalingView(cells, corpus, 'iqr');
    assert.match(md, /Monotonicity holds/);
  });

  it('surfaces a monotonicity violation as an explicit calibration warning', () => {
    // Invert the ladder: hello-world MORE expensive than crud-db ⇒ efficiency
    // does not rise ⇒ violation.
    const broken = [];
    for (let i = 0; i < 4; i += 1) {
      broken.push(
        card({
          scenario: 'hello-world',
          arm: 'mandrel',
          runId: `hw-m-${i}`,
          totalTokens: 900000,
          tokenRatio: 1.0,
        }),
      );
      broken.push(
        card({
          scenario: 'crud-db',
          arm: 'mandrel',
          runId: `crud-m-${i}`,
          totalTokens: 180000, // LOWER than hello-world → violation
          tokenRatio: 4.0, // HIGHER than hello-world → violation
        }),
      );
    }
    const cells = groupCells(broken);
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const md = renderScalingView(cells, corpus, 'iqr');
    assert.match(md, /Calibration warning/);
    assert.match(md, /\[calibration\]/);
    assert.equal(corpus.difficultyMonotonicity.monotonicityHolds, false);
  });
});

describe('recommendImprovements — actionable, evidence-linked findings', () => {
  it('surfaces the overhead-floor estimate even when it does not trigger a recommendation', () => {
    const corpus = scoreCorpus({
      cells: groupCells(healthyCorpus()).map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const findings = recommendImprovements(corpus);
    const floorFinding = findings.find((f) =>
      f.id.startsWith('overhead-floor'),
    );
    assert.ok(floorFinding, 'overhead floor must always be surfaced');
    assert.match(floorFinding.evidence, /overhead floor/i);
  });

  it('recommends a ceremony-lite path when a positive floor buys no quality gain', () => {
    // hello-world: Mandrel costs far more tokens than control, SAME quality.
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      cards.push(
        card({
          scenario: 'hello-world',
          arm: 'mandrel',
          runId: `hw-m-${i}`,
          quality: 0.9,
          totalTokens: 200000,
          costUsd: 1.6,
        }),
      );
      cards.push(
        card({
          scenario: 'hello-world',
          arm: 'control',
          runId: `hw-c-${i}`,
          quality: 0.9, // identical quality → no gain
          totalTokens: 40000,
          costUsd: 0.3,
        }),
      );
    }
    const corpus = scoreCorpus({
      cells: groupCells(cards).map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const findings = recommendImprovements(corpus);
    const ceremonyLite = findings.find(
      (f) => f.id === 'overhead-floor-ceremony-lite',
    );
    assert.ok(ceremonyLite, 'expected a ceremony-lite recommendation');
    assert.equal(ceremonyLite.severity, 'high');
    assert.match(ceremonyLite.action, /ceremony/i);
  });

  it('flags a real value-dimension regression where control beats mandrel', () => {
    // crud-db: control quality clearly HIGHER than mandrel (a regression the
    // scaffolding should not cause).
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      cards.push(
        card({
          scenario: 'crud-db',
          arm: 'mandrel',
          runId: `crud-m-${i}`,
          quality: 0.4 + i * 0.005,
        }),
      );
      cards.push(
        card({
          scenario: 'crud-db',
          arm: 'control',
          runId: `crud-c-${i}`,
          quality: 0.9 - i * 0.005,
        }),
      );
    }
    const corpus = scoreCorpus({
      cells: groupCells(cards).map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const findings = recommendImprovements(corpus);
    const regression = findings.find((f) =>
      f.id.startsWith('regression-crud-db-quality'),
    );
    assert.ok(regression, 'expected a quality regression finding');
    assert.equal(regression.severity, 'medium');
  });
});

describe('renderReport — full Markdown', () => {
  it('renders every required section', () => {
    const md = renderReport({ scorecards: healthyCorpus(), method: 'iqr' });
    assert.match(md, /# Mandrel Self-Benchmark — Value-Add Report/);
    assert.match(md, /## Cohort/);
    assert.match(md, /## Dimension distributions \(Mandrel vs bare control\)/);
    assert.match(md, /## Per-difficulty scaling view/);
    assert.match(md, /## Recommended improvements/);
    // Every dimension label appears.
    assert.match(md, /Quality/);
    assert.match(md, /Planning fidelity/);
    assert.match(md, /Autonomy/);
    assert.match(md, /Overhead ratio/);
    assert.match(md, /Efficiency · total tokens/);
  });

  it('is deterministic — identical corpus renders byte-for-byte identically', () => {
    const a = renderReport({ scorecards: healthyCorpus() });
    const b = renderReport({ scorecards: healthyCorpus() });
    assert.equal(a, b);
  });

  it('renders a graceful empty report for an empty corpus', () => {
    const md = renderReport({ scorecards: [] });
    assert.match(md, /nothing to render/i);
    assert.match(md, /## Recommended improvements/);
  });

  it('surfaces the mixed-cohort warning in the header', () => {
    const md = renderReport({
      scorecards: [
        card({ runId: 'a', frameworkVersion: '1.70.0' }),
        card({ runId: 'b', frameworkVersion: '1.71.0' }),
      ],
    });
    assert.match(md, /Mixed cohort/);
  });

  it('throws on a non-array corpus', () => {
    assert.throws(() => renderReport({ scorecards: 'nope' }), TypeError);
  });
});

describe('buildReportModel — structured form', () => {
  it('returns the same findings the Markdown is built from', () => {
    const model = buildReportModel({ scorecards: healthyCorpus() });
    assert.equal(model.scenarios.length, 2);
    assert.ok(Array.isArray(model.recommendations));
    assert.ok(model.overheadFloor); // hello-world present → floor computed
    assert.equal(model.monotonicity.monotonicityHolds, true);
  });
});
