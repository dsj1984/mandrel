/**
 * Unit tests for `lib/signals/detectors/retry.js`
 * (Epic #1721 / Story #1768 / Task #1778).
 *
 * Covers every AC bullet:
 *   - Empty / missing traces → returns [] without throwing.
 *   - Single failure → no emission (1 > threshold=3 is false).
 *   - Repeated failures under threshold → no emission.
 *   - At threshold → no emission (strict `>`).
 *   - Over threshold → exactly one emission per offending identity.
 *   - Success-after-failures → still emits (failure-count is monotonic).
 *   - Whitespace-paraphrase collapse: 4 different raw `targetHash`es,
 *     identical `normalizedHash` → grouped as one identity.
 *   - `npm test` ≡ `npm run test` collapse: 2 raw forms, identical
 *     `normalizedHash` → one identity (separate from `npm run lint`,
 *     which keeps its own `normalizedHash` and does NOT collapse).
 *
 * Plus the schema/shape contract: every emission carries
 * `{ ts, kind:'retry', source:{tool:'retry-detector'}, epicId, storyId,
 *   taskId, details:{ commandHash, failureCount, threshold,
 *   normalizationRules } }` per `.agents/schemas/signal-event.schema.json`.
 *
 * Plus the barrel-resolves contract: `import { detectRetry } from
 * '.agents/scripts/lib/signals/detectors/index.js'` works.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectRetry as detectRetryFromBarrel } from '../../../../.agents/scripts/lib/signals/detectors/index.js';
import {
  detectRetry,
  NORMALIZATION_RULES,
} from '../../../../.agents/scripts/lib/signals/detectors/retry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const EPIC_ID = 1721;
const STORY_ID = 1768;
const TASK_ID = 1773;
const DEFAULT_THRESHOLD = 3;

let scratchDir;

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), 'retry-detector-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

async function run(fixture, threshold) {
  return detectRetry({
    tracesPath: fixturePath(fixture),
    epicId: EPIC_ID,
    storyId: STORY_ID,
    taskId: TASK_ID,
    threshold,
  });
}

describe('detectRetry — barrel resolves', () => {
  it('exports detectRetry from the detectors barrel', () => {
    assert.equal(typeof detectRetryFromBarrel, 'function');
    assert.equal(detectRetryFromBarrel, detectRetry);
  });
});

describe('detectRetry — empty / missing inputs', () => {
  it('returns [] when the traces file is missing (does not throw)', async () => {
    const events = await detectRetry({
      tracesPath: path.join(scratchDir, 'does-not-exist.ndjson'),
      epicId: EPIC_ID,
      storyId: STORY_ID,
      taskId: TASK_ID,
      threshold: DEFAULT_THRESHOLD,
    });
    assert.deepEqual(events, []);
  });

  it('returns [] for a single failure (1 not > threshold)', async () => {
    const events = await run('retry-single-failure.ndjson', DEFAULT_THRESHOLD);
    assert.deepEqual(events, []);
  });
});

describe('detectRetry — threshold semantics', () => {
  it('does not emit when failure count is under threshold (2 fails, threshold 3)', async () => {
    const events = await run('retry-under-threshold.ndjson', DEFAULT_THRESHOLD);
    assert.deepEqual(events, []);
  });

  it('does not emit when failure count equals threshold (3 fails, threshold 3 — strict >)', async () => {
    const events = await run('retry-at-threshold.ndjson', DEFAULT_THRESHOLD);
    assert.deepEqual(events, []);
  });

  it('emits exactly once when a single identity exceeds threshold (4 fails, threshold 3)', async () => {
    const events = await run('retry-over-threshold.ndjson', DEFAULT_THRESHOLD);
    assert.equal(events.length, 1);
    const [evt] = events;
    assert.equal(evt.details.failureCount, 4);
    assert.equal(evt.details.threshold, DEFAULT_THRESHOLD);
    assert.equal(
      evt.details.commandHash,
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
  });

  it('accepts threshold === 0 (every failed identity emits)', async () => {
    const events = await run('retry-single-failure.ndjson', 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].details.failureCount, 1);
    assert.equal(events[0].details.threshold, 0);
  });
});

describe('detectRetry — success after failures (monotonic count)', () => {
  it('emits when failure count exceeds threshold even though a later run succeeded', async () => {
    // Fixture: 4 failures + 1 success of the same identity.
    const events = await run(
      'retry-success-after-failures.ndjson',
      DEFAULT_THRESHOLD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].details.failureCount, 4, 'success must NOT cancel');
    assert.equal(
      events[0].details.commandHash,
      'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    );
  });
});

describe('detectRetry — paraphrase collapse via normalizedHash', () => {
  it('collapses whitespace-paraphrase failures by normalizedHash (4 raw forms, 1 identity)', async () => {
    const events = await run(
      'retry-whitespace-collapse.ndjson',
      DEFAULT_THRESHOLD,
    );
    // Without collapse the 4 records would each look like a single
    // failure (no emission). With collapse they aggregate to 4 > 3 → emit.
    assert.equal(events.length, 1);
    assert.equal(events[0].details.failureCount, 4);
    assert.equal(
      events[0].details.commandHash,
      'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    );
  });

  it('collapses `npm test` ≡ `npm run test` (4 fails) but NOT `npm run lint` (2 fails)', async () => {
    // Fixture: 4 failures share normalizedHash 8888… (the npm test pair)
    // and 2 failures share normalizedHash 6666… (npm run lint, distinct).
    const events = await run(
      'retry-npm-run-collapse.ndjson',
      DEFAULT_THRESHOLD,
    );
    assert.equal(
      events.length,
      1,
      'only the collapsed-npm-test identity should emit; npm run lint stays under threshold',
    );
    assert.equal(events[0].details.failureCount, 4);
    assert.equal(
      events[0].details.commandHash,
      'sha256:8888888888888888888888888888888888888888888888888888888888888888',
    );
  });

  it('emits multiple events when several identities exceed threshold (sorted by commandHash)', async () => {
    // Re-run npm-run-collapse with threshold 1 so both identities qualify.
    const events = await run('retry-npm-run-collapse.ndjson', 1);
    assert.equal(events.length, 2);
    // Stable sort by commandHash ascending (66… < 88…).
    assert.equal(
      events[0].details.commandHash,
      'sha256:6666666666666666666666666666666666666666666666666666666666666666',
    );
    assert.equal(events[0].details.failureCount, 2);
    assert.equal(
      events[1].details.commandHash,
      'sha256:8888888888888888888888888888888888888888888888888888888888888888',
    );
    assert.equal(events[1].details.failureCount, 4);
  });
});

describe('detectRetry — emission shape (schema contract)', () => {
  it('emits SignalEvents matching signal-event.schema.json', async () => {
    const events = await run('retry-over-threshold.ndjson', DEFAULT_THRESHOLD);
    assert.equal(events.length, 1);
    const [evt] = events;

    // Required envelope fields per signal-event.schema.json.
    assert.equal(typeof evt.ts, 'string');
    assert.match(evt.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(evt.kind, 'retry');
    assert.deepEqual(evt.source, { tool: 'retry-detector' });
    assert.equal(evt.epicId, EPIC_ID);
    assert.equal(evt.storyId, STORY_ID);
    assert.equal(evt.taskId, TASK_ID);

    // Per-kind details.
    assert.equal(typeof evt.details, 'object');
    assert.equal(typeof evt.details.commandHash, 'string');
    assert.match(evt.details.commandHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(typeof evt.details.failureCount, 'number');
    assert.equal(typeof evt.details.threshold, 'number');
    assert.ok(Array.isArray(evt.details.normalizationRules));
    assert.deepEqual(evt.details.normalizationRules, [...NORMALIZATION_RULES]);
  });

  it('passes taskId through as null when omitted', async () => {
    const events = await detectRetry({
      tracesPath: fixturePath('retry-over-threshold.ndjson'),
      epicId: EPIC_ID,
      storyId: STORY_ID,
      threshold: DEFAULT_THRESHOLD,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].taskId, null);
  });

  it('emits a defensive copy of NORMALIZATION_RULES (callers cannot mutate the canonical list)', async () => {
    const events = await run('retry-over-threshold.ndjson', DEFAULT_THRESHOLD);
    assert.equal(events.length, 1);
    const rules = events[0].details.normalizationRules;
    // The exported list is frozen; the emitted list is a fresh array.
    assert.notEqual(rules, NORMALIZATION_RULES);
    assert.equal(Object.isFrozen(NORMALIZATION_RULES), true);
  });
});

describe('detectRetry — argument validation', () => {
  const baseArgs = () => ({
    tracesPath: fixturePath('retry-over-threshold.ndjson'),
    epicId: EPIC_ID,
    storyId: STORY_ID,
    taskId: TASK_ID,
    threshold: DEFAULT_THRESHOLD,
  });

  it('throws TypeError when args is not an object', async () => {
    await assert.rejects(() => detectRetry(null), TypeError);
    await assert.rejects(() => detectRetry(undefined), TypeError);
  });

  it('throws TypeError when tracesPath is missing or empty', async () => {
    await assert.rejects(
      () => detectRetry({ ...baseArgs(), tracesPath: '' }),
      TypeError,
    );
    await assert.rejects(
      () => detectRetry({ ...baseArgs(), tracesPath: 42 }),
      TypeError,
    );
  });

  it('throws RangeError for non-positive epicId / storyId', async () => {
    await assert.rejects(
      () => detectRetry({ ...baseArgs(), epicId: 0 }),
      RangeError,
    );
    await assert.rejects(
      () => detectRetry({ ...baseArgs(), storyId: -1 }),
      RangeError,
    );
  });

  it('throws RangeError for negative threshold', async () => {
    await assert.rejects(
      () => detectRetry({ ...baseArgs(), threshold: -1 }),
      RangeError,
    );
  });

  it('throws RangeError for non-positive taskId (when not null)', async () => {
    await assert.rejects(
      () => detectRetry({ ...baseArgs(), taskId: 0 }),
      RangeError,
    );
  });
});

describe('detectRetry — fixture-size contract (privacy: < 4KB each)', () => {
  it('keeps every fixture file under 4KB to enforce literal-hex hash discipline', async () => {
    const fixtures = [
      'retry-single-failure.ndjson',
      'retry-under-threshold.ndjson',
      'retry-at-threshold.ndjson',
      'retry-over-threshold.ndjson',
      'retry-success-after-failures.ndjson',
      'retry-whitespace-collapse.ndjson',
      'retry-npm-run-collapse.ndjson',
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
