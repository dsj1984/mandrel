import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import { tick } from '../../.agents/scripts/lib/wave-runner/tick.js';
import { WaveRunnerError } from '../../.agents/scripts/lib/wave-runner/wave-runner-error.js';

/**
 * Fake `Checkpointer.read()` returning a fixed state.
 */
function fakeCheckpointer(state) {
  return { read: async () => state };
}

/**
 * Fake provider with `getTicket(id)` returning labels from the supplied map.
 */
function fakeProvider(labelsById = new Map()) {
  return {
    async getTicket(id) {
      return {
        id,
        labels: labelsById.get(id) ?? [],
        title: `Story #${id}`,
      };
    },
  };
}

/**
 * Capture emitted signals via a stub `signalEmit`.
 */
function captureSignals() {
  const emitted = [];
  return {
    emitted,
    signalEmit: async (signal) => emitted.push(signal),
  };
}

describe('lib/wave-runner/tick', () => {
  it('returns epic-complete when currentWave >= totalWaves', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 2,
      totalWaves: 2,
      plan: [[{ id: 1 }], [{ id: 2 }]],
      waves: [
        { index: 0, status: 'complete' },
        { index: 1, status: 'complete' },
      ],
    });
    const provider = fakeProvider();
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.deepEqual(result.blockedStories, []);
    assert.deepEqual(result.gateFailures, []);
    assert.equal(result.currentWave, 2);
    assert.equal(result.totalWaves, 2);
    assert.ok(sig.emitted.some((e) => e.kind === 'epic-complete'));
  });

  it('returns wave-complete for an empty wave plan', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 2,
      plan: [[], [{ id: 1 }]],
      waves: [],
    });
    const provider = fakeProvider();
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'wave-complete');
    assert.equal(result.nextAction.index, 0);
    assert.ok(sig.emitted.some((e) => e.kind === 'wave-complete'));
  });

  it('returns dispatch for an undispatched wave (and emits wave-start once)', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 2,
      plan: [
        [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
        ],
        [{ id: 3 }],
      ],
      waves: [],
    });
    // Both stories carry agent::ready — undispatched.
    const provider = fakeProvider(
      new Map([
        [1, ['agent::ready', 'type::story']],
        [2, ['agent::ready', 'type::story']],
      ]),
    );
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.equal(result.nextAction.stories.length, 2);
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
    assert.ok(sig.emitted.some((e) => e.kind === 'wave-start'));
    assert.ok(sig.emitted.some((e) => e.kind === 'wave-tick'));
  });

  it('refills mid-wave: dispatch returns only the still-undispatched stories', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }, { id: 2 }, { id: 3 }]],
      waves: [],
    });
    // 1 is done, 2 executing, 3 undispatched.
    const provider = fakeProvider(
      new Map([
        [1, [AGENT_LABELS.DONE]],
        [2, [AGENT_LABELS.EXECUTING]],
        [3, ['agent::ready']],
      ]),
    );
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [3],
    );
    // wave-start does NOT fire on a refill — done/executing are non-empty.
    assert.equal(
      sig.emitted.some((e) => e.kind === 'wave-start'),
      false,
    );
  });

  it('returns observe with blockedStories when any wave member is agent::blocked', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }, { id: 2 }]],
      waves: [],
    });
    const provider = fakeProvider(
      new Map([
        [1, [AGENT_LABELS.DONE]],
        [2, [AGENT_LABELS.BLOCKED]],
      ]),
    );
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [2]);
    assert.equal(result.blockedStories.length, 1);
    assert.equal(result.blockedStories[0].storyId, 2);
    assert.equal(result.blockedStories[0].reason, 'agent::blocked');
  });

  it('returns wave-complete on full wave done (not last wave)', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 2,
      plan: [[{ id: 1 }, { id: 2 }], [{ id: 3 }]],
      waves: [],
    });
    const provider = fakeProvider(
      new Map([
        [1, [AGENT_LABELS.DONE]],
        [2, [AGENT_LABELS.DONE]],
      ]),
    );
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'wave-complete');
    assert.equal(result.nextAction.index, 0);
    assert.ok(sig.emitted.some((e) => e.kind === 'wave-complete'));
  });

  it('returns epic-complete on full wave done in the last wave', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 1,
      totalWaves: 2,
      plan: [[{ id: 1 }], [{ id: 2 }]],
      waves: [{ index: 0, status: 'complete' }],
    });
    const provider = fakeProvider(new Map([[2, [AGENT_LABELS.DONE]]]));
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.ok(sig.emitted.some((e) => e.kind === 'epic-complete'));
  });

  it('throws WaveRunnerError(checkpoint-missing) when no checkpoint exists', async () => {
    const checkpointer = fakeCheckpointer(null);
    const provider = fakeProvider();
    await assert.rejects(
      tick({ epic: 100, collaborators: { provider, epicRunStateStore: checkpointer } }),
      (err) =>
        err instanceof WaveRunnerError && err.phase === 'checkpoint-missing',
    );
  });

  it('throws WaveRunnerError(checkpoint-read) when checkpointer.read fails', async () => {
    const checkpointer = {
      read: async () => {
        throw new Error('GH 503');
      },
    };
    const provider = fakeProvider();
    await assert.rejects(
      tick({ epic: 100, collaborators: { provider, epicRunStateStore: checkpointer } }),
      (err) =>
        err instanceof WaveRunnerError && err.phase === 'checkpoint-read',
    );
  });

  it('throws WaveRunnerError(story-fetch) when provider.getTicket throws', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }]],
      waves: [],
    });
    const provider = {
      async getTicket() {
        throw new Error('rate-limited');
      },
    };
    await assert.rejects(
      tick({ epic: 100, collaborators: { provider, epicRunStateStore: checkpointer } }),
      (err) => err instanceof WaveRunnerError && err.phase === 'story-fetch',
    );
  });

  it('throws WaveRunnerError(invalid-input) on a non-positive epic id', async () => {
    await assert.rejects(
      tick({ epic: 0, collaborators: { provider: fakeProvider() } }),
      (err) => err instanceof WaveRunnerError && err.phase === 'invalid-input',
    );
  });

  it('accepts both `epic: number` and `epic: { id }` argument shapes', async () => {
    const state = {
      currentWave: 0,
      totalWaves: 1,
      plan: [[]],
      waves: [],
    };
    const checkpointer = fakeCheckpointer(state);
    const provider = fakeProvider();

    const r1 = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: async () => {} },
    });
    const r2 = await tick({
      epic: { id: 100 },
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: async () => {} },
    });
    assert.equal(r1.nextAction.kind, r2.nextAction.kind);
  });

  it('emits a wave-tick signal on every call (one per invocation)', async () => {
    const checkpointer = fakeCheckpointer({
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }]],
      waves: [],
    });
    const provider = fakeProvider(new Map([[1, ['agent::ready']]]));
    const sig = captureSignals();

    await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: checkpointer, signalEmit: sig.signalEmit },
    });
    const tickCount = sig.emitted.filter((e) => e.kind === 'wave-tick').length;
    assert.equal(tickCount, 1);
  });
});
