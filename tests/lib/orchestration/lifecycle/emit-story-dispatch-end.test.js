/**
 * Unit tests for `emit-story-dispatch-end.js` (Story #3900).
 *
 * Covers: schema-valid append, the status→outcome mapping, argument
 * guards, and that the record shape matches the `emitted` envelope the
 * wave-tick reconciler reads to derive in-flight Stories.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  emitStoryDispatchEnd,
  storyStatusToDispatchOutcome,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/emit-story-dispatch-end.js';

describe('emit-story-dispatch-end', () => {
  let dir;
  let ledgerPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dispatch-end-'));
    ledgerPath = path.join(dir, 'lifecycle.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one schema-valid `emitted` record per call', () => {
    const { record } = emitStoryDispatchEnd({
      epicId: 100,
      storyId: 200,
      outcome: 'done',
      durationMs: 1234,
      timestamp: '2026-06-10T00:00:00.000Z',
      ledgerPath,
    });
    assert.equal(record.kind, 'emitted');
    assert.equal(record.event, 'story.dispatch.end');
    assert.deepEqual(record.payload, {
      storyId: 200,
      outcome: 'done',
      durationMs: 1234,
    });

    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'story.dispatch.end');
    assert.equal(parsed.payload.storyId, 200);
  });

  it('defaults durationMs to 0 when omitted', () => {
    const { record } = emitStoryDispatchEnd({
      epicId: 1,
      storyId: 2,
      outcome: 'blocked',
      ledgerPath,
    });
    assert.equal(record.payload.durationMs, 0);
  });

  it('closes the start/end pairing the in-flight reconciler reads', () => {
    // A start without an end is in-flight; emitting the end clears it.
    emitStoryDispatchEnd({ epicId: 1, storyId: 7, outcome: 'done', ledgerPath });
    const raw = readFileSync(ledgerPath, 'utf8');
    const ended = new Set();
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (r.event === 'story.dispatch.end') ended.add(r.payload.storyId);
    }
    assert.ok(ended.has(7));
  });

  it('rejects an invalid outcome', () => {
    assert.throws(
      () =>
        emitStoryDispatchEnd({
          epicId: 1,
          storyId: 2,
          outcome: 'in-progress',
          ledgerPath,
        }),
      /must be one of/,
    );
  });

  it('rejects a non-positive epicId / storyId', () => {
    assert.throws(
      () =>
        emitStoryDispatchEnd({
          epicId: 0,
          storyId: 2,
          outcome: 'done',
          ledgerPath,
        }),
      /epicId must be a positive integer/,
    );
    assert.throws(
      () =>
        emitStoryDispatchEnd({
          epicId: 1,
          storyId: -1,
          outcome: 'done',
          ledgerPath,
        }),
      /storyId must be a positive integer/,
    );
  });

  it('rejects a negative durationMs', () => {
    assert.throws(
      () =>
        emitStoryDispatchEnd({
          epicId: 1,
          storyId: 2,
          outcome: 'done',
          durationMs: -5,
          ledgerPath,
        }),
      /durationMs must be a non-negative integer/,
    );
  });
});

describe('storyStatusToDispatchOutcome', () => {
  it('maps the three recorded story statuses to outcomes (identity)', () => {
    assert.equal(storyStatusToDispatchOutcome('done'), 'done');
    assert.equal(storyStatusToDispatchOutcome('blocked'), 'blocked');
    assert.equal(storyStatusToDispatchOutcome('failed'), 'failed');
    assert.equal(storyStatusToDispatchOutcome('skipped'), 'skipped');
  });

  it('throws on an unknown status', () => {
    assert.throws(
      () => storyStatusToDispatchOutcome('complete'),
      /unknown story status/,
    );
  });
});
