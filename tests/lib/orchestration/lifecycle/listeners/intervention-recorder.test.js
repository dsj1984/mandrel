// tests/lib/orchestration/lifecycle/listeners/intervention-recorder.test.js
/**
 * Unit tests for InterventionRecorder — verifies that an
 * `intervention.recorded` emit produces exactly one
 * `appendIntervention` call against the epic-run-state store, that a
 * repeat seqId is a no-op (idempotency contract per
 * listeners/README.md), and that the store call shape is faithful to
 * the bus payload.
 *
 * Story #2410 / Task #2416.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  createInterventionRecorder,
  INTERVENTION_RECORDED_EVENT,
  InterventionRecorder,
} from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/intervention-recorder.js';

function quietLogger() {
  return { info() {}, warn() {}, debug() {} };
}

function makeRecorder({ epicId = 2307, appendCalls = [], provider } = {}) {
  return new InterventionRecorder({
    provider: provider ?? { tag: 'p' },
    epicId,
    logger: quietLogger(),
    appendIntervention: async (args) => {
      appendCalls.push(args);
      return { ok: true };
    },
  });
}

describe('InterventionRecorder — constructor guards', () => {
  it('rejects a missing provider', () => {
    assert.throws(
      () => new InterventionRecorder({ epicId: 1, logger: quietLogger() }),
      /provider/,
    );
  });

  it('rejects a non-numeric epicId', () => {
    assert.throws(
      () =>
        new InterventionRecorder({
          provider: {},
          epicId: 'x',
          logger: quietLogger(),
        }),
      /numeric epicId/,
    );
  });

  it('rejects epicId < 1', () => {
    assert.throws(
      () =>
        new InterventionRecorder({
          provider: {},
          epicId: 0,
          logger: quietLogger(),
        }),
      /numeric epicId/,
    );
  });

  it('exposes the subscribed event taxonomy', () => {
    const recorder = makeRecorder();
    assert.deepEqual([...recorder.events], [INTERVENTION_RECORDED_EVENT]);
  });
});

describe('InterventionRecorder.register', () => {
  it('rejects a bus without on()', () => {
    const recorder = makeRecorder();
    assert.throws(() => recorder.register({}), /bus with on\(\)/);
  });

  it('subscribes to intervention.recorded on the supplied bus', () => {
    const bus = new Bus();
    const recorder = makeRecorder();
    const unsubs = recorder.register(bus);
    assert.equal(unsubs.length, 1);
    assert.equal(typeof unsubs[0], 'function');
  });
});

describe('InterventionRecorder.handle — happy path', () => {
  it('invokes appendIntervention with the payload reason / source / ts', async () => {
    const bus = new Bus();
    const appendCalls = [];
    const provider = { tag: 'p' };
    const recorder = makeRecorder({
      epicId: 2307,
      appendCalls,
      provider,
    });
    recorder.register(bus);

    await bus.emit('intervention.recorded', {
      epicId: 2307,
      reason: 'host LLM ran git restore',
      source: 'host-llm',
      ts: '2026-05-18T12:34:56.789Z',
    });

    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].provider, provider);
    assert.equal(appendCalls[0].epicId, 2307);
    assert.deepEqual(appendCalls[0].entry, {
      reason: 'host LLM ran git restore',
      source: 'host-llm',
      ts: '2026-05-18T12:34:56.789Z',
    });
  });

  it('omits source / ts from the entry when absent from the payload', async () => {
    const bus = new Bus();
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });
    recorder.register(bus);

    await bus.emit('intervention.recorded', {
      epicId: 2307,
      reason: 'AskUserQuestion fired',
    });

    assert.equal(appendCalls.length, 1);
    assert.deepEqual(appendCalls[0].entry, {
      reason: 'AskUserQuestion fired',
    });
  });

  it('skips emits whose payload.epicId does not match the listener', async () => {
    const bus = new Bus();
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });
    recorder.register(bus);

    await bus.emit('intervention.recorded', {
      epicId: 9999,
      reason: 'misrouted',
    });

    assert.equal(appendCalls.length, 0);
  });
});

describe('InterventionRecorder.handle — idempotency', () => {
  it('short-circuits a repeated (event, seqId) without invoking the store', async () => {
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });

    const ctx = {
      event: 'intervention.recorded',
      seqId: 42,
      payload: { epicId: 2307, reason: 'first call' },
    };

    await recorder.handle(ctx);
    await recorder.handle(ctx);
    await recorder.handle(ctx);

    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].entry.reason, 'first call');
  });

  it('treats distinct seqIds as distinct emits even with identical payloads', async () => {
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });

    const payload = { epicId: 2307, reason: 'recurring intervention' };
    await recorder.handle({
      event: 'intervention.recorded',
      seqId: 1,
      payload,
    });
    await recorder.handle({
      event: 'intervention.recorded',
      seqId: 2,
      payload,
    });

    assert.equal(appendCalls.length, 2);
  });

  it('resetSeen clears the seqId guard', async () => {
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });

    const ctx = {
      event: 'intervention.recorded',
      seqId: 7,
      payload: { epicId: 2307, reason: 'replay' },
    };

    await recorder.handle(ctx);
    assert.equal(appendCalls.length, 1);

    recorder.resetSeen();
    await recorder.handle(ctx);
    assert.equal(appendCalls.length, 2);
  });

  it('ignores events other than intervention.recorded', async () => {
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });

    await recorder.handle({
      event: 'epic.complete',
      seqId: 1,
      payload: { epicId: 2307 },
    });

    assert.equal(appendCalls.length, 0);
  });
});

describe('InterventionRecorder — error propagation', () => {
  it('re-throws when appendIntervention rejects (resume contract)', async () => {
    const recorder = new InterventionRecorder({
      provider: {},
      epicId: 2307,
      logger: quietLogger(),
      appendIntervention: async () => {
        throw new Error('boom');
      },
    });

    await assert.rejects(
      recorder.handle({
        event: 'intervention.recorded',
        seqId: 1,
        payload: { epicId: 2307, reason: 'will fail' },
      }),
      /boom/,
    );
  });
});

describe('createInterventionRecorder factory', () => {
  it('returns an InterventionRecorder instance', () => {
    const recorder = createInterventionRecorder({
      provider: {},
      epicId: 2307,
      logger: quietLogger(),
    });
    assert.ok(recorder instanceof InterventionRecorder);
  });
});

describe('Bus integration — schema validation', () => {
  it('rejects an emit missing required reason', async () => {
    const bus = new Bus();
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });
    recorder.register(bus);

    await assert.rejects(
      bus.emit('intervention.recorded', { epicId: 2307 }),
      /reason|required/i,
    );
    assert.equal(appendCalls.length, 0);
  });

  it('rejects an emit with epicId < 1', async () => {
    const bus = new Bus();
    const appendCalls = [];
    const recorder = makeRecorder({ epicId: 2307, appendCalls });
    recorder.register(bus);

    await assert.rejects(
      bus.emit('intervention.recorded', { epicId: 0, reason: 'bad id' }),
      /epicId|minimum|>=/i,
    );
    assert.equal(appendCalls.length, 0);
  });
});
