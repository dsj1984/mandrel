// tests/lib/orchestration/lifecycle/listener-signals.test.js
/**
 * Unit test for SignalsAppender (Story #2239 Task #2244). Verifies
 * seqId-keyed idempotent NDJSON append.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { SignalsAppender } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/signals-appender.js';

function buildFakeAppend() {
  const calls = [];
  return {
    calls,
    appendEpicSignal: async ({ epicId, signal }) => {
      calls.push({ epicId, signal });
      return true;
    },
  };
}

describe('SignalsAppender', () => {
  it('appends one row per subscribed event', async () => {
    const bus = new Bus();
    const writer = buildFakeAppend();
    const appender = new SignalsAppender({
      epicId: 777,
      appendEpicSignal: writer.appendEpicSignal,
      now: () => Date.UTC(2026, 0, 1),
      logger: { debug() {}, warn() {} },
    });
    appender.register(bus);

    await bus.emit('story.dispatch.end', {
      storyId: 1,
      outcome: 'done',
      durationMs: 100,
    });
    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 1: 'done' },
    });
    await bus.emit('story.blocked', { storyId: 9, reason: 'flaky' });

    assert.equal(writer.calls.length, 3);
    assert.equal(writer.calls[0].epicId, 777);
    assert.equal(writer.calls[0].signal.kind, 'story.dispatch.end');
    assert.equal(writer.calls[0].signal.seqId, 1);
    assert.deepEqual(writer.calls[0].signal.payload, {
      storyId: 1,
      outcome: 'done',
      durationMs: 100,
    });
  });

  it('re-invoking with the same (event, seqId) does NOT produce a duplicate line', async () => {
    const bus = new Bus();
    const writer = buildFakeAppend();
    const appender = new SignalsAppender({
      epicId: 777,
      appendEpicSignal: writer.appendEpicSignal,
      logger: { debug() {}, warn() {} },
    });
    appender.register(bus);

    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 1: 'done' },
    });
    // Manual replay with the same seqId — must be a no-op.
    await appender.handle({
      event: 'wave.end',
      seqId: 1,
      payload: { waveIndex: 0, outcomes: { 1: 'done' } },
    });

    assert.equal(
      writer.calls.length,
      1,
      'duplicate (event, seqId) must NOT append twice',
    );
  });

  it('subscribes only to the contracted events', () => {
    const writer = buildFakeAppend();
    const appender = new SignalsAppender({
      epicId: 1,
      appendEpicSignal: writer.appendEpicSignal,
    });
    assert.deepEqual(
      [...appender.events],
      ['story.dispatch.end', 'story.blocked', 'wave.end'],
    );
  });

  it('swallows writer errors so a flaky disk does not crash the bus', async () => {
    const bus = new Bus();
    const appender = new SignalsAppender({
      epicId: 1,
      appendEpicSignal: async () => {
        throw new Error('EROFS');
      },
      logger: { debug() {}, warn() {} },
    });
    appender.register(bus);
    // The bus must not propagate the error.
    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 1: 'done' },
    });
  });
});
