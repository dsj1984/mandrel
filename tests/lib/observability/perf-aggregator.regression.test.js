/**
 * Regression test: pin `lib/observability/perf-aggregator.js` to byte-
 * equal output against a captured signals.ndjson fixture (Epic #1181 /
 * Story #1438 / Task #1462).
 *
 * The fixture (`fixtures/perf-aggregator-baseline.ndjson`) is a real
 * captured signals stream — a mix of friction, hotspot, rework, retry,
 * and trace events covering every code path the aggregator's helpers
 * exercise. The expected payload
 * (`fixtures/perf-aggregator-baseline.json`) was generated from the
 * post-Task-#1460 aggregator and is committed alongside the fixture as
 * the regression baseline.
 *
 * AC #1 (regression test fails on a reverted-to-direct-parse aggregator)
 * is satisfied indirectly: any change that breaks `signals.read`
 * forwarding (e.g., reintroducing inline `readFileSync` + `split('\n')`
 * with a different envelope filter) would either drop events or admit
 * malformed ones, shifting the counts here.
 *
 * The test covers both ingestion paths:
 *   1. **In-memory iterable**: the canonical
 *      `computeStoryPerfSummary(events, opts)` / `computeEpicPerfReport`
 *      surface (the bulk of the test).
 *   2. **Streaming-from-store**: the new `*FromStore` helpers that
 *      route through `lib/signals/read.js`. We materialise the fixture
 *      into a temp `tempRoot` and assert the streaming path produces
 *      the same byte-equal payload.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeEpicPerfReport,
  computeEpicPerfReportFromStore,
  computeStoryPerfSummary,
  computeStoryPerfSummaryFromStore,
} from '../../../.agents/scripts/lib/observability/perf-aggregator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_NDJSON = path.join(
  __dirname,
  'fixtures',
  'perf-aggregator-baseline.ndjson',
);
const FIXTURE_BASELINE = path.join(
  __dirname,
  'fixtures',
  'perf-aggregator-baseline.json',
);

// The closedAt / generatedAt values in the baseline JSON are fixed so
// the deepEqual is deterministic. We thread them through opts so the
// aggregator doesn't fill in `new Date().toISOString()`.
const STORY_OPTS = {
  storyId: 1041,
  epicId: 1030,
  closedAt: '2026-05-09T10:30:00.000Z',
  phaseTiming: {
    phases: [
      { name: 'install', elapsedMs: 4000 },
      { name: 'test', elapsedMs: 9000 },
    ],
  },
};

const EPIC_OPTS = {
  epicId: 1030,
  generatedAt: '2026-05-09T10:31:00.000Z',
};

async function loadEvents() {
  const raw = await fs.readFile(FIXTURE_NDJSON, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function loadBaseline() {
  return JSON.parse(await fs.readFile(FIXTURE_BASELINE, 'utf8'));
}

describe('perf-aggregator regression — captured fixture', () => {
  it('Story payload is byte-equal to the committed baseline', async () => {
    const events = await loadEvents();
    const baseline = await loadBaseline();
    const story = computeStoryPerfSummary(events, STORY_OPTS);
    assert.deepEqual(story, baseline.story);
  });

  it('Epic payload is byte-equal to the committed baseline (with raw events for signalCounts)', async () => {
    const events = await loadEvents();
    const baseline = await loadBaseline();
    const story = computeStoryPerfSummary(events, STORY_OPTS);
    const epic = computeEpicPerfReport([story], {
      ...EPIC_OPTS,
      events,
    });
    assert.deepEqual(epic, baseline.epic);
  });
});

describe('perf-aggregator regression — streaming-from-store path', () => {
  let workRoot;
  let cfg;

  beforeEach(async () => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'perf-aggregator-regression-'));
    cfg = { paths: { tempRoot: workRoot } };
    const dir = path.join(workRoot, 'epic-1030', 'story-1041');
    await fs.mkdir(dir, { recursive: true });
    const raw = await fs.readFile(FIXTURE_NDJSON, 'utf8');
    await fs.writeFile(path.join(dir, 'signals.ndjson'), raw, 'utf8');
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('computeStoryPerfSummaryFromStore matches the committed baseline', async () => {
    const baseline = await loadBaseline();
    const story = await computeStoryPerfSummaryFromStore({
      ...STORY_OPTS,
      config: cfg,
    });
    assert.deepEqual(story, baseline.story);
  });

  it('computeEpicPerfReportFromStore matches the committed baseline', async () => {
    const baseline = await loadBaseline();
    const story = await computeStoryPerfSummaryFromStore({
      ...STORY_OPTS,
      config: cfg,
    });
    const epic = await computeEpicPerfReportFromStore({
      ...EPIC_OPTS,
      perStorySummaries: [story],
      config: cfg,
    });
    assert.deepEqual(epic, baseline.epic);
  });
});
