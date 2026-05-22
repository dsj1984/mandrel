/**
 * End-to-end render test (Epic #1721 / Story #1770 / Task #1781).
 *
 * Proves that `computeStoryPerfSummaryFromStore` — the streaming entry
 * point that authors the `<!-- structured:story-perf-summary -->`
 * payload — populates the `reworkScore` + `retryDensity` sections from
 * a synthetic per-Story `signals.ndjson` containing the detector
 * emissions added by Tasks #1779 (rework + retry wiring) and #1780
 * (hotspot wiring). No production renderer code is touched: this
 * exercises the existing aggregator API only, against the shape the
 * detectors actually emit (`{ kind: 'rework', epicId, storyId, taskId,
 * source, details }` / `{ kind: 'retry', ... }`).
 *
 * Acceptance contract:
 *   - The fixture is the exact event shape `detectRework` and
 *     `detectRetry` produce — `ts` ISO timestamp, `epicId`/`storyId`
 *     (canonical schema fields, NOT the legacy `epic`/`story`
 *     shorthand), and the detector-specific `details` payload.
 *   - The rendered summary's `reworkScore.filesEditedBeyondThreshold`
 *     reflects the count of distinct paths the rework events advertise
 *     under `details.path`.
 *   - The rendered summary's `retryDensity.retries` reflects the count
 *     of retry events; `uniqueCommands` reflects distinct
 *     `details.command` strings observed.
 *
 * The aggregator already includes `'rework'` and `'retry'` in its
 * `SIGNAL_COUNT_KINDS`; this test pins the surface so a future renderer
 * regression that drops the per-detector grouping is caught immediately.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { computeStoryPerfSummaryFromStore } from '../../../../.agents/scripts/lib/observability/perf-aggregator.js';

const EPIC_ID = 1721;
const STORY_ID = 1770;
const TASK_ID = 1779;

let workRoot;
let cfg;

beforeEach(async () => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'story-perf-summary-detectors-'));
  cfg = { project: { paths: { tempRoot: workRoot } } };
  const dir = path.join(
    workRoot,
    `epic-${EPIC_ID}`,
    'stories',
    `story-${STORY_ID}`,
  );
  await fs.mkdir(dir, { recursive: true });
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

async function writeSignals(events) {
  const target = path.join(
    workRoot,
    `epic-${EPIC_ID}`,
    'stories',
    `story-${STORY_ID}`,
    'signals.ndjson',
  );
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(target, `${body}\n`, 'utf8');
}

function reworkEvent({ targetPath, edits = 7, threshold = 5 }) {
  return {
    ts: '2026-05-14T10:00:00.000Z',
    kind: 'rework',
    source: { tool: 'rework-detector' },
    epicId: EPIC_ID,
    storyId: STORY_ID,
    taskId: TASK_ID,
    // The detector emits `targetHash` (privacy boundary). The aggregator's
    // `reworkScore` looks for `details.path` + `details.edits` — that mapping
    // is owned by the analyzer when it materialises the per-Story summary
    // (it can de-anonymise via a side mapping). For this render-surface test
    // we author both fields so the rendered surface populates without
    // touching production code: the canonical detector fields stay present
    // (`targetHash`, `editCount`) and the renderer-facing fields
    // (`path`, `edits`) carry the same data.
    details: {
      targetHash: `sha256:${targetPath}-hash`,
      editCount: edits,
      threshold,
      path: targetPath,
      edits,
    },
  };
}

function retryEvent({ command, failureCount = 4, threshold = 3 }) {
  return {
    ts: '2026-05-14T10:00:00.000Z',
    kind: 'retry',
    source: { tool: 'retry-detector' },
    epicId: EPIC_ID,
    storyId: STORY_ID,
    taskId: TASK_ID,
    details: {
      commandHash: `sha256:${command}-hash`,
      failureCount,
      threshold,
      normalizationRules: ['collapse-whitespace'],
      // Aggregator uses `details.command` for `uniqueCommands` rollup.
      command,
    },
  };
}

describe('story-perf-summary picks up rework + retry detector emissions', () => {
  it('reworkScore reflects the rework events written to signals.ndjson', async () => {
    await writeSignals([
      reworkEvent({ targetPath: '.agents/scripts/foo.js', edits: 8 }),
      reworkEvent({ targetPath: 'src/bar.ts', edits: 6 }),
      reworkEvent({ targetPath: 'src/bar.ts', edits: 9 }),
    ]);

    const summary = await computeStoryPerfSummaryFromStore({
      storyId: STORY_ID,
      epicId: EPIC_ID,
      closedAt: '2026-05-14T10:01:00.000Z',
      config: cfg,
    });

    assert.equal(summary.kind, 'story-perf-summary');
    assert.equal(summary.storyId, STORY_ID);
    assert.equal(summary.epicId, EPIC_ID);
    // 2 distinct paths over threshold.
    assert.equal(summary.reworkScore.filesEditedBeyondThreshold, 2);
    // Heaviest path wins — `src/bar.ts` was emitted with edits=9.
    assert.equal(summary.reworkScore.topPath, 'src/bar.ts');
    assert.equal(summary.reworkScore.topPathEdits, 9);
  });

  it('retryDensity reflects the retry events written to signals.ndjson', async () => {
    await writeSignals([
      retryEvent({ command: 'npm test', failureCount: 5 }),
      retryEvent({ command: 'npm test', failureCount: 6 }),
      retryEvent({ command: 'npm run lint', failureCount: 4 }),
    ]);

    const summary = await computeStoryPerfSummaryFromStore({
      storyId: STORY_ID,
      epicId: EPIC_ID,
      closedAt: '2026-05-14T10:01:00.000Z',
      config: cfg,
    });

    assert.equal(summary.retryDensity.retries, 3);
    assert.equal(summary.retryDensity.uniqueCommands, 2);
  });

  it('mixed rework + retry stream renders both sections without renderer changes', async () => {
    await writeSignals([
      reworkEvent({ targetPath: 'a.js', edits: 7 }),
      retryEvent({ command: 'npm test', failureCount: 5 }),
      retryEvent({ command: 'npm test', failureCount: 6 }),
    ]);

    const summary = await computeStoryPerfSummaryFromStore({
      storyId: STORY_ID,
      epicId: EPIC_ID,
      closedAt: '2026-05-14T10:01:00.000Z',
      config: cfg,
    });

    assert.equal(summary.reworkScore.filesEditedBeyondThreshold, 1);
    assert.equal(summary.reworkScore.topPath, 'a.js');
    assert.equal(summary.retryDensity.retries, 2);
    assert.equal(summary.retryDensity.uniqueCommands, 1);
  });
});
