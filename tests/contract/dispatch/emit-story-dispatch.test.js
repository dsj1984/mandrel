// tests/contract/dispatch/emit-story-dispatch.test.js
/**
 * Contract test — Story #2891 Task #2906.
 *
 * `lifecycle-emit-story-dispatch.js` MUST append exactly one
 * `story.dispatch.start` NDJSON line per invocation, carrying the
 * canonical { storyId, waveIndex, dispatchedAt, attempt } payload, and
 * MUST be additive across retries — a re-run with attempt=2 leaves the
 * attempt=1 line untouched.
 *
 * The test uses the programmatic surface
 * (`emitStoryDispatchStart`) so the assertions stay focused on the
 * record shape rather than on argv plumbing; a sibling end-to-end
 * harness can shell out the CLI when the dispatch flow is wired up in
 * /epic-deliver Phase 2.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { emitStoryDispatchStart } from '../../../.agents/scripts/lifecycle-emit-story-dispatch.js';

describe('contract/dispatch/emit-story-dispatch', () => {
  let sandbox;
  let ledgerPath;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'emit-story-dispatch-'));
    ledgerPath = path.join(sandbox, 'lifecycle.ndjson');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('appends exactly one NDJSON record with the four-field payload', () => {
    emitStoryDispatchStart({
      epicId: 1,
      storyId: 2,
      waveIndex: 0,
      attempt: 1,
      dispatchedAt: '2026-05-22T00:00:00.000Z',
      ledgerPath,
    });

    const raw = readFileSync(ledgerPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, 'exactly one NDJSON line');
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'story.dispatch.start');
    assert.deepEqual(record.payload, {
      storyId: 2,
      waveIndex: 0,
      dispatchedAt: '2026-05-22T00:00:00.000Z',
      attempt: 1,
    });
  });

  it('re-running with attempt=2 appends a second line and leaves the first untouched', () => {
    emitStoryDispatchStart({
      epicId: 1,
      storyId: 2,
      waveIndex: 0,
      attempt: 1,
      dispatchedAt: '2026-05-22T00:00:00.000Z',
      ledgerPath,
    });
    const firstSnapshot = readFileSync(ledgerPath, 'utf8');

    emitStoryDispatchStart({
      epicId: 1,
      storyId: 2,
      waveIndex: 0,
      attempt: 2,
      dispatchedAt: '2026-05-22T00:00:05.000Z',
      ledgerPath,
    });
    const secondSnapshot = readFileSync(ledgerPath, 'utf8');

    assert.ok(
      secondSnapshot.startsWith(firstSnapshot),
      'second-attempt snapshot must be a strict superset of the first',
    );
    const lines = secondSnapshot.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    const second = JSON.parse(lines[1]);
    assert.equal(second.payload.attempt, 2);
    assert.equal(second.payload.dispatchedAt, '2026-05-22T00:00:05.000Z');
  });

  it('rejects an invalid payload (storyId < 1) at schema validation time', () => {
    assert.throws(
      () =>
        emitStoryDispatchStart({
          epicId: 1,
          storyId: 0,
          waveIndex: 0,
          attempt: 1,
          dispatchedAt: '2026-05-22T00:00:00.000Z',
          ledgerPath,
        }),
      /schema validation/,
    );
  });
});
