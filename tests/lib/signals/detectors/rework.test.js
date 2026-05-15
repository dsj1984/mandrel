/**
 * Unit tests for `lib/signals/detectors/rework.js`
 * (Epic #1721 / Story #1771 / Task #1772).
 *
 * Covers every AC bullet:
 *   - Empty / missing traces → returns [] without throwing.
 *   - Single file under threshold → no emission.
 *   - Single file at threshold → no emission (strict `>`).
 *   - Single file over threshold → exactly one emission per file.
 *   - Multi-file (one over, one under) → only the offender emits.
 *   - Non-edit tool events → ignored entirely.
 *
 * Plus the schema/shape contract: every emission carries
 * `{ ts, kind:'rework', source:{tool:'rework-detector'}, epicId, storyId,
 *   taskId, details:{ targetHash, editCount, threshold } }` per
 * `.agents/schemas/signal-event.schema.json`.
 *
 * Plus the barrel-resolves contract: `import { detectRework } from
 * '.agents/scripts/lib/signals/detectors/index.js'` works.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectRework as detectReworkFromBarrel } from '../../../../.agents/scripts/lib/signals/detectors/index.js';
import { detectRework } from '../../../../.agents/scripts/lib/signals/detectors/rework.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const EPIC_ID = 1721;
const STORY_ID = 1771;
const TASK_ID = 1772;

let scratchDir;

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), 'rework-detector-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

async function run(fixture, threshold) {
  return detectRework({
    tracesPath: fixturePath(fixture),
    epicId: EPIC_ID,
    storyId: STORY_ID,
    taskId: TASK_ID,
    threshold,
  });
}

describe('detectRework — barrel resolves', () => {
  it('exports detectRework from the detectors barrel', () => {
    assert.equal(typeof detectReworkFromBarrel, 'function');
    assert.equal(detectReworkFromBarrel, detectRework);
  });
});

describe('detectRework — empty / missing inputs', () => {
  it('returns [] for an empty traces.ndjson', async () => {
    const events = await run('rework-empty.ndjson', 0);
    assert.deepEqual(events, []);
  });

  it('returns [] when the traces file is missing (does not throw)', async () => {
    const events = await detectRework({
      tracesPath: path.join(scratchDir, 'does-not-exist.ndjson'),
      epicId: EPIC_ID,
      storyId: STORY_ID,
      taskId: TASK_ID,
      threshold: 5,
    });
    assert.deepEqual(events, []);
  });
});

describe('detectRework — threshold semantics', () => {
  it('does not emit for a single file under threshold (3 edits, threshold 5)', async () => {
    const events = await run('rework-under-threshold.ndjson', 5);
    assert.deepEqual(events, []);
  });

  it('does not emit when edit count equals threshold (5 edits, threshold 5 — strict >)', async () => {
    const events = await run('rework-at-threshold.ndjson', 5);
    assert.deepEqual(events, []);
  });

  it('emits exactly once when a single file exceeds threshold (6 edits, threshold 5)', async () => {
    const events = await run('rework-over-threshold.ndjson', 5);
    assert.equal(events.length, 1);
    const [evt] = events;
    assert.equal(evt.details.editCount, 6);
    assert.equal(evt.details.threshold, 5);
    assert.equal(
      evt.details.targetHash,
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
  });
});

describe('detectRework — multi-file behaviour', () => {
  it('emits one event per offending file and skips files under threshold', async () => {
    const events = await run('rework-multi-file.ndjson', 5);
    assert.equal(events.length, 1, 'only the over-threshold file should emit');
    const [evt] = events;
    assert.equal(
      evt.details.targetHash,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    );
    assert.equal(evt.details.editCount, 6);
    assert.equal(evt.details.threshold, 5);
  });

  it('emits multiple events when several files exceed threshold (sorted by targetHash)', async () => {
    // Lower threshold so both files qualify (d=6, e=2).
    const events = await run('rework-multi-file.ndjson', 1);
    assert.equal(events.length, 2);
    // Stable sort by targetHash ascending.
    assert.equal(
      events[0].details.targetHash,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    );
    assert.equal(events[0].details.editCount, 6);
    assert.equal(
      events[1].details.targetHash,
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    );
    assert.equal(events[1].details.editCount, 2);
  });
});

describe('detectRework — tool filtering', () => {
  it('ignores non-file-mutating tool events (Read, Bash, Grep, Glob)', async () => {
    // 7 events all targeting the same hash, but none are Edit/Write/MultiEdit/NotebookEdit.
    const events = await run('rework-non-edit-tools.ndjson', 0);
    assert.deepEqual(events, []);
  });
});

describe('detectRework — emission shape (schema contract)', () => {
  it('emits SignalEvents matching signal-event.schema.json', async () => {
    const events = await run('rework-over-threshold.ndjson', 5);
    assert.equal(events.length, 1);
    const [evt] = events;

    // Required envelope fields per signal-event.schema.json.
    assert.equal(typeof evt.ts, 'string');
    assert.match(evt.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(evt.kind, 'rework');
    assert.deepEqual(evt.source, { tool: 'rework-detector' });
    assert.equal(evt.epicId, EPIC_ID);
    assert.equal(evt.storyId, STORY_ID);
    assert.equal(evt.taskId, TASK_ID);

    // Per-kind details.
    assert.equal(typeof evt.details, 'object');
    assert.equal(typeof evt.details.targetHash, 'string');
    assert.equal(typeof evt.details.editCount, 'number');
    assert.equal(typeof evt.details.threshold, 'number');
  });

  it('passes taskId through as null when omitted', async () => {
    const events = await detectRework({
      tracesPath: fixturePath('rework-over-threshold.ndjson'),
      epicId: EPIC_ID,
      storyId: STORY_ID,
      threshold: 5,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].taskId, null);
  });
});

describe('detectRework — argument validation', () => {
  const baseArgs = () => ({
    tracesPath: fixturePath('rework-over-threshold.ndjson'),
    epicId: EPIC_ID,
    storyId: STORY_ID,
    taskId: TASK_ID,
    threshold: 5,
  });

  it('throws TypeError when args is not an object', async () => {
    await assert.rejects(() => detectRework(null), TypeError);
    await assert.rejects(() => detectRework(undefined), TypeError);
  });

  it('throws TypeError when tracesPath is missing or empty', async () => {
    await assert.rejects(
      () => detectRework({ ...baseArgs(), tracesPath: '' }),
      TypeError,
    );
    await assert.rejects(
      () => detectRework({ ...baseArgs(), tracesPath: 42 }),
      TypeError,
    );
  });

  it('throws RangeError for non-positive epicId / storyId', async () => {
    await assert.rejects(
      () => detectRework({ ...baseArgs(), epicId: 0 }),
      RangeError,
    );
    await assert.rejects(
      () => detectRework({ ...baseArgs(), storyId: -1 }),
      RangeError,
    );
  });

  it('throws RangeError for negative threshold', async () => {
    await assert.rejects(
      () => detectRework({ ...baseArgs(), threshold: -1 }),
      RangeError,
    );
  });

  it('accepts threshold === 0 (every offending file emits)', async () => {
    const events = await run('rework-under-threshold.ndjson', 0);
    // 3 edits > 0 → emission.
    assert.equal(events.length, 1);
    assert.equal(events[0].details.editCount, 3);
    assert.equal(events[0].details.threshold, 0);
  });
});

describe('detectRework — fixture-size contract (privacy: < 4KB each)', () => {
  it('keeps every fixture file under 4KB to enforce literal-hex hash discipline', async () => {
    const fixtures = [
      'rework-empty.ndjson',
      'rework-under-threshold.ndjson',
      'rework-at-threshold.ndjson',
      'rework-over-threshold.ndjson',
      'rework-multi-file.ndjson',
      'rework-non-edit-tools.ndjson',
    ];
    for (const name of fixtures) {
      const { size } = statSync(fixturePath(name));
      assert.ok(
        size < 4 * 1024,
        `fixture ${name} is ${size} bytes; must be < 4096`,
      );
    }
    // Touch fs to keep the helper alive in lint.
    void fs;
  });
});
