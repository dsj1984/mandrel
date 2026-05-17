// tests/lifecycle/bus.test.js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus, createBus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';

/**
 * The bus is the contract surface for every downstream listener. These
 * tests pin the four invariants the Tech Spec calls out:
 *   1. schema validation runs BEFORE any listener;
 *   2. listeners run sequentially with await (order + serialization);
 *   3. a thrown listener short-circuits the remaining listeners;
 *   4. wildcard observers run after named listeners.
 */

describe('lifecycle/bus', () => {
  it('emit() validates payload and throws BEFORE invoking any listener on schema mismatch', async () => {
    const bus = new Bus();
    let listenerRan = false;
    bus.on('epic.snapshot.start', () => {
      listenerRan = true;
    });
    await assert.rejects(
      () => bus.emit('epic.snapshot.start', { wrong: 'shape' }),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        assert.equal(err.event, 'epic.snapshot.start');
        return true;
      },
    );
    assert.equal(
      listenerRan,
      false,
      'listener must not run when validation fails',
    );
  });

  it('listeners run sequentially with await — second listener does not start until the first resolves', async () => {
    const bus = new Bus();
    const events = [];
    bus.on('epic.snapshot.start', async () => {
      events.push('A:start');
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push('A:end');
    });
    bus.on('epic.snapshot.start', async () => {
      events.push('B:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('B:end');
    });
    await bus.emit('epic.snapshot.start', { epicId: 1 });
    assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('a thrown listener short-circuits remaining listeners and surfaces the error', async () => {
    const bus = new Bus();
    let secondRan = false;
    bus.on('epic.snapshot.start', () => {
      throw new Error('listener-1-boom');
    });
    bus.on('epic.snapshot.start', () => {
      secondRan = true;
    });
    await assert.rejects(() => bus.emit('epic.snapshot.start', { epicId: 1 }), {
      message: 'listener-1-boom',
    });
    assert.equal(secondRan, false, 'second listener must not run after a throw');
  });

  it('wildcard observers run AFTER named listeners, sequentially', async () => {
    const bus = new Bus();
    const order = [];
    bus.on('epic.snapshot.start', () => {
      order.push('named-1');
    });
    bus.on('*', () => {
      order.push('wildcard-1');
    });
    bus.on('epic.snapshot.start', () => {
      order.push('named-2');
    });
    bus.on('*', () => {
      order.push('wildcard-2');
    });
    await bus.emit('epic.snapshot.start', { epicId: 1 });
    assert.deepEqual(order, [
      'named-1',
      'named-2',
      'wildcard-1',
      'wildcard-2',
    ]);
  });

  it('emit() assigns a monotonic per-run seqId starting at 1', async () => {
    const bus = new Bus();
    bus.on('epic.snapshot.start', () => {});
    bus.on('epic.snapshot.end', () => {});
    const r1 = await bus.emit('epic.snapshot.start', { epicId: 1 });
    const r2 = await bus.emit('epic.snapshot.end', {
      epicId: 1,
      storyIds: [10],
    });
    const r3 = await bus.emit('epic.snapshot.end', {
      epicId: 1,
      storyIds: [11],
    });
    assert.equal(r1.seqId, 1);
    assert.equal(r2.seqId, 2);
    assert.equal(r3.seqId, 3);
  });

  it('on(event, fn) returns an unsubscribe function', async () => {
    const bus = new Bus();
    let count = 0;
    const off = bus.on('epic.snapshot.start', () => {
      count += 1;
    });
    await bus.emit('epic.snapshot.start', { epicId: 1 });
    off();
    await bus.emit('epic.snapshot.start', { epicId: 1 });
    assert.equal(count, 1);
  });

  it('on(*) returns an unsubscribe function that removes the wildcard observer', async () => {
    const bus = new Bus();
    let count = 0;
    const off = bus.on('*', () => {
      count += 1;
    });
    bus.on('epic.snapshot.start', () => {});
    await bus.emit('epic.snapshot.start', { epicId: 1 });
    off();
    await bus.emit('epic.snapshot.start', { epicId: 1 });
    assert.equal(count, 1);
  });

  it('on() rejects a non-function listener', () => {
    const bus = new Bus();
    assert.throws(() => bus.on('epic.snapshot.start', null), TypeError);
    assert.throws(
      () => bus.on('epic.snapshot.start', 'not a function'),
      TypeError,
    );
  });

  it('on() rejects an empty event name', () => {
    const bus = new Bus();
    assert.throws(() => bus.on('', () => {}), TypeError);
    assert.throws(() => bus.on(null, () => {}), TypeError);
  });

  it('emit() rejects an empty event name', async () => {
    const bus = new Bus();
    await assert.rejects(() => bus.emit('', {}), TypeError);
  });

  it('listener receives a context object carrying event, seqId, and payload', async () => {
    const bus = new Bus();
    let received = null;
    bus.on('epic.snapshot.start', (ctx) => {
      received = ctx;
    });
    await bus.emit('epic.snapshot.start', { epicId: 42 });
    assert.deepEqual(received, {
      event: 'epic.snapshot.start',
      seqId: 1,
      payload: { epicId: 42 },
    });
  });

  it('createBus() returns a Bus instance', () => {
    const bus = createBus();
    assert.ok(bus instanceof Bus);
  });
});
