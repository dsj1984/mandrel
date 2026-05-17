// tests/lib/orchestration/lifecycle/listener-checkpoint.test.js
/**
 * Unit tests for the lifecycle CheckpointPointerWriter listener
 * (Story #2266 / Task #2268, Epic #2172).
 *
 * Acceptance contract:
 *   - Subscribes to every `*.end` event in the lifecycle taxonomy.
 *   - After each `*.end` writes
 *     `temp/epic-<id>/checkpoint.json` with
 *     `{ lastCompletedSeqId, phase }` where `lastCompletedSeqId`
 *     monotonically increases.
 *   - Self-emits `checkpoint.written` exactly once per observed
 *     `*.end` — duplicate `(event, seqId)` is a no-op.
 *   - Pointer file content reflects the most recent `*.end`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  buildPointerPayload,
  CHECKPOINT_WRITTEN_EVENT,
  CheckpointPointerWriter,
  POINTER_FILENAME,
  resolvePointerPath,
  SUBSCRIBED_END_EVENTS,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/checkpoint-pointer-writer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-pointer-writer-'));
}

function readPointer(pointerPath) {
  return JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
}

describe('resolvePointerPath', () => {
  it('builds <tempRoot>/epic-<id>/checkpoint.json', () => {
    assert.equal(
      resolvePointerPath({ tempRoot: '/t', epicId: 2172 }),
      path.join('/t', 'epic-2172', POINTER_FILENAME),
    );
  });

  it('rejects a non-string tempRoot', () => {
    assert.throws(() => resolvePointerPath({ tempRoot: '', epicId: 1 }));
  });

  it('rejects a non-numeric epicId', () => {
    assert.throws(() => resolvePointerPath({ tempRoot: '/t', epicId: 'x' }));
  });
});

describe('buildPointerPayload', () => {
  it('passes through lastCompletedSeqId and phase verbatim', () => {
    assert.deepEqual(
      buildPointerPayload({ lastCompletedSeqId: 7, phase: 'wave.end' }),
      { lastCompletedSeqId: 7, phase: 'wave.end' },
    );
  });
});

describe('SUBSCRIBED_END_EVENTS taxonomy alignment', () => {
  it('matches every *.end schema file on disk', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const schemaDir = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '.agents',
      'schemas',
      'lifecycle',
    );
    const onDisk = fs
      .readdirSync(schemaDir)
      .filter((f) => /\.end\.schema\.json$/.test(f))
      .map((f) => f.replace(/\.schema\.json$/, ''))
      .sort();
    const subscribed = [...SUBSCRIBED_END_EVENTS].sort();
    assert.deepEqual(subscribed, onDisk);
  });

  it('does NOT include `checkpoint.written` (self-emit must not loop)', () => {
    assert.equal(SUBSCRIBED_END_EVENTS.includes(CHECKPOINT_WRITTEN_EVENT), false);
  });
});

describe('CheckpointPointerWriter — constructor guards', () => {
  it('rejects missing bus', () => {
    assert.throws(
      () => new CheckpointPointerWriter({ epicId: 1, tempRoot: '/t' }),
      /bus with on\(\) and emit\(\)/,
    );
  });

  it('rejects non-numeric epicId', () => {
    assert.throws(
      () =>
        new CheckpointPointerWriter({
          bus: new Bus(),
          epicId: 'x',
          tempRoot: '/t',
        }),
      /numeric epicId/,
    );
  });

  it('rejects empty tempRoot', () => {
    assert.throws(
      () =>
        new CheckpointPointerWriter({
          bus: new Bus(),
          epicId: 1,
          tempRoot: '',
        }),
      /non-empty tempRoot/,
    );
  });
});

describe('CheckpointPointerWriter — pointer write + self-emit', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = mkTempRoot();
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes the pointer file after a wave.end and self-emits checkpoint.written', async () => {
    const bus = new Bus();
    const writer = new CheckpointPointerWriter({
      bus,
      epicId: 2172,
      tempRoot,
      logger: quietLogger(),
    });
    writer.register();

    const observed = [];
    bus.on(CHECKPOINT_WRITTEN_EVENT, async (ctx) => {
      observed.push({ seqId: ctx.seqId, payload: ctx.payload });
    });

    await bus.emit('wave.end', { waveIndex: 0, outcomes: {} });

    const pointer = readPointer(writer.pointerPath);
    assert.equal(pointer.phase, 'wave.end');
    assert.equal(typeof pointer.lastCompletedSeqId, 'number');
    assert.equal(pointer.lastCompletedSeqId >= 1, true);
    // Self-emit landed exactly once.
    assert.equal(observed.length, 1);
    assert.equal(observed[0].payload.phase, 'wave.end');
    assert.equal(
      observed[0].payload.lastCompletedSeqId,
      pointer.lastCompletedSeqId,
    );
  });

  it('advances lastCompletedSeqId monotonically across multiple *.end events', async () => {
    const bus = new Bus();
    const writer = new CheckpointPointerWriter({
      bus,
      epicId: 2172,
      tempRoot,
      logger: quietLogger(),
    });
    writer.register();

    const seqIds = [];
    bus.on(CHECKPOINT_WRITTEN_EVENT, async (ctx) => {
      seqIds.push(ctx.payload.lastCompletedSeqId);
    });

    await bus.emit('epic.plan.end', { waves: [[1]] });
    const afterPlan = readPointer(writer.pointerPath);
    await bus.emit('wave.end', { waveIndex: 0, outcomes: {} });
    const afterWave1 = readPointer(writer.pointerPath);
    await bus.emit('wave.end', { waveIndex: 1, outcomes: {} });
    const afterWave2 = readPointer(writer.pointerPath);

    assert.equal(afterPlan.phase, 'epic.plan.end');
    assert.equal(afterWave1.phase, 'wave.end');
    assert.equal(afterWave2.phase, 'wave.end');
    assert.equal(
      afterPlan.lastCompletedSeqId < afterWave1.lastCompletedSeqId,
      true,
    );
    assert.equal(
      afterWave1.lastCompletedSeqId < afterWave2.lastCompletedSeqId,
      true,
    );
    // Three `*.end` observations → three self-emits.
    assert.equal(seqIds.length, 3);
    // Strict monotonicity of self-emitted seqIds.
    for (let i = 1; i < seqIds.length; i += 1) {
      assert.equal(seqIds[i] > seqIds[i - 1], true);
    }
  });

  it('emits checkpoint.written exactly once per *.end (duplicate seqId is a no-op)', async () => {
    const bus = new Bus();
    const writer = new CheckpointPointerWriter({
      bus,
      epicId: 2172,
      tempRoot,
      logger: quietLogger(),
    });
    writer.register();

    let count = 0;
    bus.on(CHECKPOINT_WRITTEN_EVENT, async () => {
      count += 1;
    });

    await bus.emit('wave.end', { waveIndex: 0, outcomes: {} });
    // Replay the same context via the handler directly to exercise
    // the seqId guard — the bus would assign a different seqId on a
    // fresh emit, so we hit the handle() seam directly to model a
    // resume re-delivery.
    const lastSeqId = readPointer(writer.pointerPath).lastCompletedSeqId;
    await writer.handle({
      event: 'wave.end',
      seqId: lastSeqId,
      payload: { waveIndex: 0, outcomes: {} },
    });

    assert.equal(count, 1, 'self-emit must fire exactly once');
  });

  it('ignores non-advancing seqId (resume / out-of-order replay)', async () => {
    const bus = new Bus();
    const writer = new CheckpointPointerWriter({
      bus,
      epicId: 2172,
      tempRoot,
      logger: quietLogger(),
    });
    writer.register();

    let count = 0;
    bus.on(CHECKPOINT_WRITTEN_EVENT, async () => {
      count += 1;
    });

    await bus.emit('wave.end', { waveIndex: 0, outcomes: {} });
    const advanced = readPointer(writer.pointerPath).lastCompletedSeqId;

    // Replay with a smaller seqId — should NOT advance the pointer
    // and MUST NOT re-emit checkpoint.written.
    await writer.handle({
      event: 'wave.end',
      seqId: 0,
      payload: { waveIndex: 0, outcomes: {} },
    });
    const replayed = readPointer(writer.pointerPath).lastCompletedSeqId;

    assert.equal(replayed, advanced);
    assert.equal(count, 1);
  });

  it('persists the last seqId across multiple distinct *.end events on disk', async () => {
    const bus = new Bus();
    const writer = new CheckpointPointerWriter({
      bus,
      epicId: 2172,
      tempRoot,
      logger: quietLogger(),
    });
    writer.register();

    await bus.emit('epic.snapshot.end', { epicId: 2172, storyIds: [] });
    await bus.emit('epic.plan.end', { waves: [[1]] });
    await bus.emit('wave.end', { waveIndex: 0, outcomes: {} });

    const finalPointer = readPointer(writer.pointerPath);
    assert.equal(finalPointer.phase, 'wave.end');
  });
});
