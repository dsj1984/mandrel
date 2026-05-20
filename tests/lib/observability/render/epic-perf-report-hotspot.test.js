/**
 * End-to-end render test (Epic #1721 / Story #1770 / Task #1783).
 *
 * Proves that `computeEpicPerfReportFromStore` — the streaming entry
 * point that authors the `<!-- structured:epic-perf-report -->`
 * payload — populates the hotspot section from a synthetic per-Epic
 * `signals.ndjson` containing the detector emissions added by Task
 * #1780 (`runHotspotDetection` calling `appendEpicSignal`).
 *
 * No production renderer code is touched — the aggregator's
 * `SIGNAL_COUNT_KINDS` already includes `'hotspot'`, so the rolled-up
 * `signalCounts.hotspot` reflects the new detector without renderer
 * changes. This test pins the surface so a future regression that
 * drops hotspot from the rollup is caught immediately.
 *
 * Acceptance contract:
 *   - Fixture is the exact event shape `detectHotspot` emits — `ts`
 *     ISO timestamp, canonical `epicId` (NOT legacy `epic` shorthand),
 *     and the detector-specific `details` payload (`targetHash`,
 *     `totalEdits`, `storiesAffected`, `p95Threshold`, `multiplier`).
 *   - `signalCounts.hotspot` matches the fixture's hotspot-event count
 *     exactly.
 *   - The fixture also includes friction events to prove the rollup
 *     stays correct when other kinds interleave.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { computeEpicPerfReportFromStore } from '../../../../.agents/scripts/lib/observability/perf-aggregator.js';

const EPIC_ID = 1721;
const STORY_ID = 1770;

let workRoot;
let cfg;

beforeEach(async () => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'epic-perf-report-hotspot-'));
  cfg = { project: { paths: { tempRoot: workRoot } } };
  // The per-Epic stream lives at `temp/epic-<eid>/signals.ndjson` (sibling
  // to per-Story dirs). The reader's `listEpicStorySignalsFiles` looks for
  // the top-level signals.ndjson before walking story dirs, so we author
  // the hotspot events at that scope (mirrors `appendEpicSignal`).
  await fs.mkdir(path.join(workRoot, `epic-${EPIC_ID}`), { recursive: true });
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

async function writeEpicSignals(events) {
  const target = path.join(workRoot, `epic-${EPIC_ID}`, 'signals.ndjson');
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(target, `${body}\n`, 'utf8');
}

async function writeStorySignals(events) {
  const dir = path.join(workRoot, `epic-${EPIC_ID}`, `story-${STORY_ID}`);
  await fs.mkdir(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(path.join(dir, 'signals.ndjson'), `${body}\n`, 'utf8');
}

function hotspotEvent({ targetHash, totalEdits = 12, storiesAffected = 3 }) {
  return {
    ts: '2026-05-14T10:00:00.000Z',
    kind: 'hotspot',
    source: { tool: 'hotspot-detector' },
    epicId: EPIC_ID,
    details: {
      targetHash,
      totalEdits,
      storiesAffected,
      p95Threshold: 7.5,
      multiplier: 1.25,
    },
  };
}

function frictionEvent(category) {
  return {
    ts: '2026-05-14T10:00:00.000Z',
    kind: 'friction',
    source: { tool: 'test' },
    epicId: EPIC_ID,
    storyId: STORY_ID,
    details: { category },
  };
}

describe('epic-perf-report picks up hotspot detector emissions', () => {
  it('signalCounts.hotspot matches the count of hotspot events in the per-Epic stream', async () => {
    await writeEpicSignals([
      hotspotEvent({ targetHash: 'sha256:a', totalEdits: 14 }),
      hotspotEvent({ targetHash: 'sha256:b', totalEdits: 18 }),
      hotspotEvent({ targetHash: 'sha256:c', totalEdits: 22 }),
    ]);

    const report = await computeEpicPerfReportFromStore({
      epicId: EPIC_ID,
      perStorySummaries: [],
      generatedAt: '2026-05-14T10:01:00.000Z',
      config: cfg,
    });

    assert.equal(report.kind, 'epic-perf-report');
    assert.equal(report.epicId, EPIC_ID);
    assert.equal(report.signalCounts.hotspot, 3);
    // Other detector counts unaffected.
    assert.equal(report.signalCounts.friction, 0);
    assert.equal(report.signalCounts.rework, 0);
    assert.equal(report.signalCounts.retry, 0);
  });

  it('signalCounts roll-up is correct when hotspot interleaves with other kinds across Epic + Story streams', async () => {
    await writeEpicSignals([
      hotspotEvent({ targetHash: 'sha256:hot1' }),
      hotspotEvent({ targetHash: 'sha256:hot2' }),
    ]);
    await writeStorySignals([
      frictionEvent('Tool Limitation'),
      frictionEvent('Execution Error'),
      hotspotEvent({ targetHash: 'sha256:hot3' }),
    ]);

    const report = await computeEpicPerfReportFromStore({
      epicId: EPIC_ID,
      perStorySummaries: [],
      generatedAt: '2026-05-14T10:01:00.000Z',
      config: cfg,
    });

    assert.equal(
      report.signalCounts.hotspot,
      3,
      'sums hotspot events from per-Epic + per-Story streams',
    );
    assert.equal(report.signalCounts.friction, 2);
  });

  it('returns zeroed signalCounts when no hotspot events are present', async () => {
    await writeStorySignals([frictionEvent('Tool Limitation')]);

    const report = await computeEpicPerfReportFromStore({
      epicId: EPIC_ID,
      perStorySummaries: [],
      generatedAt: '2026-05-14T10:01:00.000Z',
      config: cfg,
    });

    assert.equal(report.signalCounts.hotspot, 0);
    assert.equal(report.signalCounts.friction, 1);
  });
});
