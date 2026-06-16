// tests/bench/collect/normalize.test.js
//
// Unit + contract tier for the telemetry normalizer (Epic #4211, Story #4217).
// Exercises bench/collect/normalize.js:
//   - NDJSON parsing (blank-line tolerance, malformed-line failure),
//   - lifecycle-derived raw sub-signals (wall-clock, dispatch count, autonomy
//     counters, the ceremony/codegen token split),
//   - usage extraction from both the normalized and raw `claude -p` envelope
//     shapes,
//   - the binding acceptance item: the assembled per-run record CONFORMS to
//     bench/schemas/scorecard.schema.json (validated with the same Ajv 2020
//     strict setup the schema's own contract test uses),
//   - the file-reading shell via an injected reader, including reading the
//     committed bench/fixtures/lifecycle.sample.ndjson.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  buildScorecard,
  deriveAutonomyCounters,
  deriveDispatchCount,
  deriveTokenSplit,
  deriveWallClockMs,
  extractUsage,
  normalizeRunFromPaths,
  parseNdjson,
  SCORECARD_SCHEMA_VERSION,
} from '../../../bench/collect/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/bench/collect/ → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'bench',
  'schemas',
  'scorecard.schema.json',
);
const LIFECYCLE_FIXTURE = path.join(
  REPO_ROOT,
  'bench',
  'fixtures',
  'lifecycle.sample.ndjson',
);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/** A validator built exactly like the schema's own contract test. */
function buildValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** A canonical run-identity stamp (hello-world / mandrel). */
function runStamp(overrides = {}) {
  return {
    runId: 'hello-world-mandrel-2026-06-16-r01',
    timestamp: '2026-06-16T19:42:11.000Z',
    model: {
      id: 'claude-opus-4-8[1m]',
      displayName: 'Claude Opus 4.8 (1M context)',
    },
    frameworkVersion: '1.70.0',
    env: { node: 'v24.16.0', os: 'darwin', host: 'bench-runner-01' },
    scenario: 'hello-world',
    arm: 'mandrel',
    ...overrides,
  };
}

/** A normalized envelope (the shape parseSessionEnvelope returns). */
function normalizedEnvelope(overrides = {}) {
  return {
    usage: {
      inputTokens: 151200,
      outputTokens: 33120,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 184320,
    },
    cost: { totalUsd: 1.47 },
    ...overrides,
  };
}

describe('parseNdjson', () => {
  it('parses non-blank lines and skips blanks', () => {
    const recs = parseNdjson('{"a":1}\n\n  \n{"b":2}\n');
    assert.deepEqual(recs, [{ a: 1 }, { b: 2 }]);
  });

  it('throws with the 1-based line number on a malformed line', () => {
    assert.throws(() => parseNdjson('{"a":1}\nnot json\n'), /line 2/);
  });

  it('rejects a non-string input', () => {
    assert.throws(() => parseNdjson(null), TypeError);
  });
});

describe('deriveWallClockMs', () => {
  it('is the span between the earliest and latest timestamp', () => {
    const recs = [
      { ts: '2026-06-16T19:32:00.000Z' },
      { ts: '2026-06-16T19:42:11.000Z' },
      { ts: '2026-06-16T19:34:30.000Z' },
    ];
    // 19:42:11 − 19:32:00 = 611 s = 611000 ms
    assert.equal(deriveWallClockMs(recs), 611000);
  });

  it('is 0 when fewer than two timestamps are parseable', () => {
    assert.equal(deriveWallClockMs([{ ts: '2026-06-16T19:32:00.000Z' }]), 0);
    assert.equal(deriveWallClockMs([{ ts: 'nope' }, { ts: 'also nope' }]), 0);
  });
});

describe('deriveDispatchCount', () => {
  it('counts story.dispatch.start records', () => {
    const recs = [
      { event: 'story.dispatch.start', payload: { storyId: 1 } },
      { event: 'story.dispatch.start', payload: { storyId: 2 } },
      { event: 'story.dispatch.end', payload: { storyId: 1 } },
      { event: 'epic.plan.start' },
    ];
    assert.equal(deriveDispatchCount(recs), 2);
  });
});

describe('deriveAutonomyCounters', () => {
  it('counts blocked events, manual rescues, and hitl stops', () => {
    const lifecycle = [
      { event: 'epic.blocked', payload: { reason: 'x' } },
      { event: 'story.blocked', payload: { storyId: 1, reason: 'y' } },
      { event: 'intervention.recorded', payload: { epicId: 1, reason: 'z' } },
      { event: 'story.dispatch.start', payload: { storyId: 1 } },
    ];
    const signals = [
      { kind: 'hitl-stop' },
      { signal: 'hitl-stop' },
      { kind: 'other' },
    ];
    const counters = deriveAutonomyCounters({ lifecycle, signals });
    assert.deepEqual(counters, {
      hitlStops: 2,
      blockedEvents: 2,
      manualRescues: 1,
    });
  });

  it('is all zeros for a clean unattended run', () => {
    const counters = deriveAutonomyCounters({
      lifecycle: [{ event: 'story.dispatch.start', payload: { storyId: 1 } }],
      signals: [],
    });
    assert.deepEqual(counters, {
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
    });
  });
});

describe('deriveTokenSplit', () => {
  it('attributes tokens to codegen in proportion to dispatch wall-clock', () => {
    // One dispatch window of 100s inside a 200s run ⇒ 50% codegen.
    const lifecycle = [
      { event: 'epic.plan.start', ts: '2026-06-16T19:00:00.000Z' },
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:01:00.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:02:40.000Z',
        payload: { storyId: 1 },
      },
      { event: 'epic.complete', ts: '2026-06-16T19:03:20.000Z' },
    ];
    // wall = 200s, codegen window = 100s
    const split = deriveTokenSplit({
      lifecycle,
      totalTokens: 1000,
      wallClockMs: 200000,
    });
    assert.equal(split.codegenMs, 100000);
    assert.equal(split.ceremonyMs, 100000);
    assert.equal(split.codegenTokens, 500);
    assert.equal(split.ceremonyTokens, 500);
  });

  it('keeps ceremonyTokens + codegenTokens === totalTokens', () => {
    const lifecycle = [
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:01:00.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:01:33.000Z',
        payload: { storyId: 1 },
      },
    ];
    const split = deriveTokenSplit({
      lifecycle,
      totalTokens: 999,
      wallClockMs: 90000,
    });
    assert.equal(split.codegenTokens + split.ceremonyTokens, 999);
  });

  it('attributes everything to ceremony when there is no measurable codegen window', () => {
    const split = deriveTokenSplit({
      lifecycle: [{ event: 'epic.plan.start', ts: '2026-06-16T19:00:00.000Z' }],
      totalTokens: 500,
      wallClockMs: 0,
    });
    assert.equal(split.codegenTokens, 0);
    assert.equal(split.ceremonyTokens, 500);
  });

  it('clamps codegen time that would exceed wall-clock (overlapping dispatches)', () => {
    // Two fully-overlapping 200s windows inside a 200s run: summed = 400s,
    // clamped to 200s ⇒ all tokens are codegen.
    const lifecycle = [
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:00:00.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.start',
        ts: '2026-06-16T19:00:00.000Z',
        payload: { storyId: 2 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:03:20.000Z',
        payload: { storyId: 1 },
      },
      {
        event: 'story.dispatch.end',
        ts: '2026-06-16T19:03:20.000Z',
        payload: { storyId: 2 },
      },
    ];
    const split = deriveTokenSplit({
      lifecycle,
      totalTokens: 800,
      wallClockMs: 200000,
    });
    assert.equal(split.codegenMs, 200000);
    assert.equal(split.codegenTokens, 800);
    assert.equal(split.ceremonyTokens, 0);
  });
});

describe('extractUsage', () => {
  it('reads the normalized envelope shape', () => {
    const u = extractUsage(normalizedEnvelope());
    assert.deepEqual(u, {
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      costUsd: 1.47,
    });
  });

  it('reads the raw `claude -p` envelope shape and sums cache tokens', () => {
    const u = extractUsage({
      total_cost_usd: 0.35,
      usage: {
        input_tokens: 4942,
        output_tokens: 100,
        cache_creation_input_tokens: 31340,
        cache_read_input_tokens: 1000,
      },
    });
    assert.equal(u.totalTokens, 4942 + 100 + 31340 + 1000);
    assert.equal(u.inputTokens, 4942);
    assert.equal(u.outputTokens, 100);
    assert.equal(u.costUsd, 0.35);
  });

  it('returns zeros / null for a missing envelope', () => {
    assert.deepEqual(extractUsage(null), {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    });
  });
});

describe('buildScorecard — schema conformance (binding acceptance)', () => {
  it('assembles a per-run record that validates against scorecard.schema.json', () => {
    const lifecycle = parseNdjson(readFileSync(LIFECYCLE_FIXTURE, 'utf8'));
    const scorecard = buildScorecard({
      run: runStamp(),
      lifecycle,
      signals: [],
      envelope: normalizedEnvelope(),
      quality: {
        frozenSuitePassed: 3,
        frozenSuiteTotal: 3,
        acceptanceEvalScore: 1,
      },
      planning: {
        rePlanCount: 0,
        plannedStoryCount: 2,
        deliveredStoryCount: 2,
        plannedPaths: ['server.js', 'package.json'],
        actualPaths: ['server.js', 'package.json'],
      },
    });

    const validate = buildValidator();
    const ok = validate(scorecard);
    assert.ok(
      ok,
      `scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );

    assert.equal(scorecard.schemaVersion, SCORECARD_SCHEMA_VERSION);
    assert.equal(scorecard.scenario, 'hello-world');
    assert.equal(scorecard.arm, 'mandrel');
    // Five dimensions present.
    assert.deepEqual(Object.keys(scorecard.dimensions).sort(), [
      'autonomy',
      'efficiency',
      'overheadRatio',
      'planningFidelity',
      'quality',
    ]);
    // Wall-clock derived from the fixture span (19:32:00 → 19:42:11 = 611000ms).
    assert.equal(scorecard.dimensions.efficiency.wallClockMs, 611000);
    // Two dispatch.start records in the fixture.
    assert.equal(scorecard.dimensions.efficiency.dispatches, 2);
    // Clean autonomy.
    assert.equal(scorecard.dimensions.autonomy.score, 1);
    // Token split sums to the envelope total.
    assert.equal(
      scorecard.dimensions.overheadRatio.ceremonyTokens +
        scorecard.dimensions.overheadRatio.codegenTokens,
      scorecard.dimensions.efficiency.totalTokens,
    );
  });

  it('produces a schema-valid control-arm record (planningFidelity null)', () => {
    const scorecard = buildScorecard({
      run: runStamp({ runId: 'hw-control-r01', arm: 'control' }),
      lifecycle: [
        {
          kind: 'emitted',
          event: 'epic.plan.start',
          ts: '2026-06-16T19:00:00.000Z',
          payload: { epicId: 1 },
        },
        {
          kind: 'emitted',
          event: 'epic.complete',
          ts: '2026-06-16T19:01:40.000Z',
          payload: { epicId: 1, prUrl: 'https://x/y' },
        },
      ],
      envelope: normalizedEnvelope({ cost: { totalUsd: 0.2 } }),
      quality: { frozenSuitePassed: 3, frozenSuiteTotal: 3 },
    });
    const validate = buildValidator();
    assert.ok(
      validate(scorecard),
      `control scorecard failed: ${JSON.stringify(validate.errors, null, 2)}`,
    );
    assert.equal(scorecard.dimensions.planningFidelity.score, null);
    // No judge ⇒ quality is the frozen pass rate.
    assert.equal(scorecard.dimensions.quality.score, 1);
  });

  it('rejects an unknown arm', () => {
    assert.throws(
      () =>
        buildScorecard({
          run: runStamp({ arm: 'bogus' }),
          lifecycle: [],
          envelope: normalizedEnvelope(),
          quality: { frozenSuitePassed: 0, frozenSuiteTotal: 0 },
        }),
      /arm must be/,
    );
  });

  it('requires the run identity fields', () => {
    assert.throws(
      () =>
        buildScorecard({
          run: { runId: 'x' },
          lifecycle: [],
          envelope: normalizedEnvelope(),
          quality: {},
        }),
      /required/,
    );
  });
});

describe('normalizeRunFromPaths — file-reading shell', () => {
  it('reads lifecycle, signals, and envelope from disk via an injected reader', () => {
    const lifecycleText = readFileSync(LIFECYCLE_FIXTURE, 'utf8');
    const signalsText = '{"kind":"hitl-stop"}\n';
    const envelopeText = JSON.stringify(normalizedEnvelope());

    const files = {
      '/run/lifecycle.ndjson': lifecycleText,
      '/run/story-1/signals.ndjson': signalsText,
      '/run/cost-envelope.json': envelopeText,
    };
    const readFileImpl = (p) => {
      if (!(p in files)) throw new Error(`unexpected read: ${p}`);
      return files[p];
    };

    const scorecard = normalizeRunFromPaths(
      {
        run: runStamp(),
        lifecyclePath: '/run/lifecycle.ndjson',
        signalsPaths: ['/run/story-1/signals.ndjson'],
        costEnvelopePath: '/run/cost-envelope.json',
        quality: {
          frozenSuitePassed: 3,
          frozenSuiteTotal: 3,
          acceptanceEvalScore: 1,
        },
        planning: {
          rePlanCount: 0,
          plannedStoryCount: 2,
          deliveredStoryCount: 2,
        },
      },
      { readFileImpl },
    );

    const validate = buildValidator();
    assert.ok(
      validate(scorecard),
      `scorecard failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
    // The injected signals file carried one hitl-stop ⇒ one intervention.
    assert.equal(scorecard.dimensions.autonomy.hitlStops, 1);
    // rawRefs default to the supplied paths.
    assert.equal(scorecard.rawRefs.lifecycleNdjson, '/run/lifecycle.ndjson');
    assert.deepEqual(scorecard.rawRefs.signalsNdjson, [
      '/run/story-1/signals.ndjson',
    ]);
    assert.equal(scorecard.rawRefs.costEnvelope, '/run/cost-envelope.json');
  });

  it('requires lifecyclePath and costEnvelopePath', () => {
    assert.throws(
      () =>
        normalizeRunFromPaths({
          run: runStamp(),
          costEnvelopePath: '/x.json',
          quality: {},
        }),
      /lifecyclePath is required/,
    );
  });
});
