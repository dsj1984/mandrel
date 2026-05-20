// tests/lib/orchestration/wave-session.test.js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  createWaveSession,
  parseChildReturn,
  WaveSession,
} from '../../../.agents/scripts/lib/orchestration/wave-session.js';

/**
 * Wave-session pins the four primitives the host-LLM relies on:
 *   1. cap — never more than N in-flight at any moment;
 *   2. refill — next eligible story dispatched immediately on settle;
 *   3. await-all — run() resolves only after every story settles;
 *   4. child-return parsing — malformed payloads throw a typed error
 *      surfaced as a `failed` outcome (not a silent skip).
 *
 * Bus-emit ordering — submission-order `story.dispatch.start` and
 * serially-ordered `story.dispatch.end` — is covered alongside the
 * primitive (Task #2234 acceptance).
 */

/**
 * Build a deferred — a promise plus its resolve handle. Used by the
 * cap tests to hold dispatches open while we count in-flight slots.
 */
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Snapshot listener that records every bus emit in order. Returned
 * array is mutated as the bus emits; tests read it after `run()`
 * resolves.
 */
function attachEmitLedger(bus) {
  const ledger = [];
  bus.on('story.dispatch.start', ({ payload }) => {
    ledger.push({ event: 'story.dispatch.start', payload });
  });
  bus.on('story.dispatch.end', ({ payload }) => {
    ledger.push({ event: 'story.dispatch.end', payload });
  });
  return ledger;
}

describe('lib/orchestration/wave-session — primitive', () => {
  it('honours cap — never more than cap in-flight dispatches at any moment', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    let inFlight = 0;
    let peak = 0;
    const gates = new Map();
    const dispatchFn = (story) => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      const gate = defer();
      gates.set(story.id, gate);
      return gate.promise.then(() => {
        inFlight -= 1;
        return { status: 'done' };
      });
    };
    const runPromise = session.run({ stories, dispatchFn, cap: 2 });
    // Yield once so the initial submit-prime loop finishes.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      gates.size,
      2,
      'only `cap` initial dispatches should be in flight after prime',
    );
    // Release one slot — refill should dispatch the next story.
    gates.get(1).resolve();
    // Give the refill a tick to land.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gates.size, 3, 'refill should dispatch the next story (#3)');
    // Drain the rest.
    gates.get(2).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates.get(3).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates.get(4).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates.get(5).resolve();
    const result = await runPromise;
    assert.ok(peak <= 2, `peak in-flight was ${peak}; expected ≤ 2`);
    assert.deepEqual(
      Object.keys(result.outcomes)
        .map(Number)
        .sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
    for (const id of [1, 2, 3, 4, 5]) {
      assert.equal(result.outcomes[id], 'done');
    }
  });

  it('refill picks the next eligible story immediately when an in-flight one resolves', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const dispatchOrder = [];
    const gates = new Map();
    const stories = [{ id: 10 }, { id: 11 }, { id: 12 }];
    const dispatchFn = (story) => {
      dispatchOrder.push(story.id);
      const gate = defer();
      gates.set(story.id, gate);
      return gate.promise.then(() => ({ outcome: 'done' }));
    };
    const runPromise = session.run({ stories, dispatchFn, cap: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      dispatchOrder,
      [10],
      'cap=1 should only dispatch the first story initially',
    );
    gates.get(10).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      dispatchOrder,
      [10, 11],
      'next story should dispatch immediately on refill',
    );
    gates.get(11).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates.get(12).resolve();
    await runPromise;
    assert.deepEqual(dispatchOrder, [10, 11, 12]);
  });

  it('awaits all in-flight dispatches before resolving run()', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }];
    const gates = stories.map(() => defer());
    let runResolved = false;
    const dispatchFn = (story) => {
      const i = story.id - 1;
      return gates[i].promise.then(() => ({ outcome: 'done' }));
    };
    const runPromise = session
      .run({ stories, dispatchFn, cap: 2 })
      .then((result) => {
        runResolved = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runResolved, false);
    gates[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runResolved, false, 'must not resolve while #2 in flight');
    gates[1].resolve();
    await runPromise;
    assert.equal(runResolved, true);
  });

  it('4-story concurrent run with cap=2 settles all and produces complete outcomes map', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 3 });
    const stories = [{ id: 100 }, { id: 101 }, { id: 102 }, { id: 103 }];
    const dispatchFn = async (story) => {
      // Mix outcomes to assert each propagates verbatim.
      if (story.id === 101) return { status: 'blocked', reason: 'dep' };
      if (story.id === 102) return { outcome: 'skipped' };
      return { status: 'done', sha: `sha-${story.id}` };
    };
    const result = await session.run({ stories, dispatchFn, cap: 2 });
    assert.equal(result.waveIndex, 3);
    assert.deepEqual(result.outcomes, {
      100: 'done',
      101: 'blocked',
      102: 'skipped',
      103: 'done',
    });
    assert.equal(result.returns[100].sha, 'sha-100');
    assert.equal(result.returns[101].reason, 'dep');
  });
});

describe('lib/orchestration/wave-session — child-return parsing', () => {
  it('accepts both `outcome` and `status` field shapes', () => {
    assert.equal(parseChildReturn({ outcome: 'done' }, { storyId: 1 }), 'done');
    assert.equal(
      parseChildReturn({ status: 'blocked' }, { storyId: 2 }),
      'blocked',
    );
  });

  it('rejects legacy `merged` and `timeout` aliases (hard cutover)', () => {
    assert.throws(
      () => parseChildReturn({ status: 'merged' }, { storyId: 1 }),
      (err) => {
        assert.equal(err.code, 'WAVE_MALFORMED_RETURN');
        assert.equal(err.outcome, 'merged');
        return true;
      },
    );
    assert.throws(
      () => parseChildReturn({ status: 'timeout' }, { storyId: 2 }),
      (err) => {
        assert.equal(err.code, 'WAVE_MALFORMED_RETURN');
        assert.equal(err.outcome, 'timeout');
        return true;
      },
    );
  });

  it('throws WAVE_MALFORMED_RETURN when the record is null', () => {
    assert.throws(
      () => parseChildReturn(null, { storyId: 1 }),
      (err) => {
        assert.equal(err.code, 'WAVE_MALFORMED_RETURN');
        assert.equal(err.storyId, 1);
        return true;
      },
    );
  });

  it('throws WAVE_MALFORMED_RETURN when neither status nor outcome is a string', () => {
    assert.throws(
      () => parseChildReturn({}, { storyId: 5 }),
      (err) => {
        assert.equal(err.code, 'WAVE_MALFORMED_RETURN');
        return true;
      },
    );
    assert.throws(
      () => parseChildReturn({ outcome: 42 }, { storyId: 5 }),
      (err) => {
        assert.equal(err.code, 'WAVE_MALFORMED_RETURN');
        return true;
      },
    );
  });

  it('throws WAVE_MALFORMED_RETURN when outcome is an unrecognised enum value', () => {
    assert.throws(
      () => parseChildReturn({ outcome: 'partially-done' }, { storyId: 7 }),
      (err) => {
        assert.equal(err.code, 'WAVE_MALFORMED_RETURN');
        assert.equal(err.outcome, 'partially-done');
        return true;
      },
    );
  });

  it('records dispatchFn throws as `failed` outcome on the wave (no abort)', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }];
    const dispatchFn = async (story) => {
      if (story.id === 1) throw new Error('child-blew-up');
      return { outcome: 'done' };
    };
    const result = await session.run({ stories, dispatchFn, cap: 2 });
    assert.equal(result.outcomes[1], 'failed');
    assert.equal(result.outcomes[2], 'done');
    assert.equal(result.returns[1].error.message, 'child-blew-up');
  });

  it('records malformed child-return as `failed` outcome on the wave', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 9 }];
    const dispatchFn = async () => ({ status: 'partly-done' });
    const result = await session.run({ stories, dispatchFn, cap: 1 });
    assert.equal(result.outcomes[9], 'failed');
    assert.equal(result.returns[9].error.code, 'WAVE_MALFORMED_RETURN');
  });
});

describe('lib/orchestration/wave-session — bus-emit ordering', () => {
  it('story.dispatch.start emits in submission order', async () => {
    const bus = new Bus();
    const ledger = attachEmitLedger(bus);
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    // Sleep durations chosen so settle order ≠ submission order:
    // story 3 settles first, then 1, then 4, then 2.
    const delays = { 1: 20, 2: 40, 3: 5, 4: 30 };
    const dispatchFn = async (story) => {
      await new Promise((r) => setTimeout(r, delays[story.id]));
      return { status: 'done' };
    };
    await session.run({ stories, dispatchFn, cap: 4 });
    const starts = ledger.filter((r) => r.event === 'story.dispatch.start');
    assert.deepEqual(
      starts.map((r) => r.payload.storyId),
      [1, 2, 3, 4],
      'starts must be in submission order regardless of settle order',
    );
  });

  it('no two story.dispatch.end records share the same seqId — bus emits stay serial', async () => {
    const bus = new Bus();
    const seqIds = [];
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', ({ seqId }) => {
      seqIds.push(seqId);
    });
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const dispatchFn = async (story) => {
      // Force all four to settle in the same microtask cluster.
      await new Promise((r) => setTimeout(r, 5));
      return { outcome: 'done', _id: story.id };
    };
    await session.run({ stories, dispatchFn, cap: 4 });
    const unique = new Set(seqIds);
    assert.equal(
      unique.size,
      seqIds.length,
      `seqIds must be unique across dispatch.end emits; saw ${seqIds.join(', ')}`,
    );
    // Monotonic across all observed seqIds (start + end emits use the
    // same per-run counter).
    const sorted = [...seqIds].sort((a, b) => a - b);
    assert.deepEqual(
      seqIds,
      sorted,
      'seqIds should be observed in increasing order',
    );
  });

  it('dispatch.start seqId always precedes the matching dispatch.end seqId for the same story', async () => {
    const bus = new Bus();
    const startSeq = new Map();
    const endSeq = new Map();
    bus.on('story.dispatch.start', ({ seqId, payload }) => {
      startSeq.set(payload.storyId, seqId);
    });
    bus.on('story.dispatch.end', ({ seqId, payload }) => {
      endSeq.set(payload.storyId, seqId);
    });
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const dispatchFn = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { outcome: 'done' };
    };
    await session.run({ stories, dispatchFn, cap: 3 });
    for (const story of stories) {
      assert.ok(
        startSeq.get(story.id) < endSeq.get(story.id),
        `start seqId (${startSeq.get(story.id)}) must precede end seqId (${endSeq.get(story.id)}) for story #${story.id}`,
      );
    }
  });
});

describe('lib/orchestration/wave-session — construction guards', () => {
  it('createWaveSession is an alias for the constructor', () => {
    const bus = new Bus();
    const session = createWaveSession({ bus, waveIndex: 0 });
    assert.ok(session instanceof WaveSession);
  });

  it('throws when bus is missing emit()', () => {
    assert.throws(() => new WaveSession({ bus: {}, waveIndex: 0 }), TypeError);
  });

  it('throws when waveIndex is negative or non-integer', () => {
    const bus = new Bus();
    assert.throws(() => new WaveSession({ bus, waveIndex: -1 }), TypeError);
    assert.throws(() => new WaveSession({ bus, waveIndex: 1.5 }), TypeError);
  });

  it('run() throws when cap is not a positive integer', async () => {
    const bus = new Bus();
    const session = new WaveSession({ bus, waveIndex: 0 });
    await assert.rejects(
      () =>
        session.run({
          stories: [{ id: 1 }],
          dispatchFn: () => ({ status: 'done' }),
          cap: 0,
        }),
      TypeError,
    );
    await assert.rejects(
      () =>
        session.run({
          stories: [{ id: 1 }],
          dispatchFn: () => ({ status: 'done' }),
          cap: -1,
        }),
      TypeError,
    );
  });

  it('run() throws when stories array carries a non-integer id', async () => {
    const bus = new Bus();
    const session = new WaveSession({ bus, waveIndex: 0 });
    await assert.rejects(
      () =>
        session.run({
          stories: [{ id: 'x' }],
          dispatchFn: () => ({ status: 'done' }),
          cap: 1,
        }),
      TypeError,
    );
  });
});
