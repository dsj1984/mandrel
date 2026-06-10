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

// Story #3909 — the wave-lifecycle signal emits (`wave-start`, `wave-tick`,
// `wave-complete`, `epic-complete`) were retired; the tick planner now only
// returns a `nextAction` envelope. These tests assert that surviving planning
// output, not the deleted telemetry.

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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.deepEqual(result.blockedStories, []);
    assert.deepEqual(result.gateFailures, []);
    assert.equal(result.currentWave, 2);
    assert.equal(result.totalWaves, 2);
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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'wave-complete');
    assert.equal(result.nextAction.index, 0);
  });

  it('returns dispatch for an undispatched wave', async () => {
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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.equal(result.nextAction.stories.length, 2);
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [3],
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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'wave-complete');
    assert.equal(result.nextAction.index, 0);
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

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
  });

  it('throws WaveRunnerError(checkpoint-missing) when no checkpoint exists', async () => {
    const checkpointer = fakeCheckpointer(null);
    const provider = fakeProvider();
    await assert.rejects(
      tick({
        epic: 100,
        collaborators: { provider, epicRunStateStore: checkpointer },
      }),
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
      tick({
        epic: 100,
        collaborators: { provider, epicRunStateStore: checkpointer },
      }),
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
      tick({
        epic: 100,
        collaborators: { provider, epicRunStateStore: checkpointer },
      }),
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
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });
    const r2 = await tick({
      epic: { id: 100 },
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });
    assert.equal(r1.nextAction.kind, r2.nextAction.kind);
  });
});

/**
 * Fake provider that also carries a per-id `state` (`'open'` | `'closed'`),
 * needed for the closed-issue done-predicate tests below.
 */
function fakeProviderWithState({
  labelsById = new Map(),
  stateById = new Map(),
}) {
  return {
    async getTicket(id) {
      return {
        id,
        labels: labelsById.get(id) ?? [],
        state: stateById.get(id) ?? 'open',
        title: `Story #${id}`,
      };
    },
  };
}

describe('lib/wave-runner/tick — Story #3907 resilience', () => {
  it('subtracts ledger in-flight Stories from the dispatch set (no double-dispatch)', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }, { id: 2 }]],
      waves: [],
    });
    // Both look undispatched by label, but Story 1 is recorded in-flight on
    // the ledger (dispatched, label not yet flipped to agent::executing).
    const provider = fakeProvider(
      new Map([
        [1, ['agent::ready']],
        [2, ['agent::ready']],
      ]),
    );

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        inFlightReader: async () => [1],
      },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    // Only Story 2 is dispatchable — Story 1 is already in flight.
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
    assert.deepEqual(result.nextAction['in-flight'], [1]);
  });

  it('observes (does not re-dispatch) when every wave member is in-flight by ledger but unflipped by label', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }]],
      waves: [],
    });
    const provider = fakeProvider(new Map([[1, ['agent::ready']]]));

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        inFlightReader: async () => [1],
      },
    });

    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [1]);
    // Must NOT collapse the wave into wave-complete while a Story is in flight.
    assert.notEqual(result.nextAction.kind, 'wave-complete');
  });

  it('treats a manually-closed Story (state=closed, no agent::done) as done — not re-dispatched', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }, { id: 2 }]],
      waves: [],
    });
    // Story 1: closed issue but label never flipped. Story 2: ready.
    const provider = fakeProviderWithState({
      labelsById: new Map([
        [1, ['agent::ready']],
        [2, ['agent::ready']],
      ]),
      stateById: new Map([
        [1, 'closed'],
        [2, 'open'],
      ]),
    });

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    // Closed Story 1 is done; only Story 2 dispatches.
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
  });

  it('advances to epic-complete when the only wave member is a manually-closed Story', async () => {
    const checkpointer = fakeCheckpointer({
      epicId: 100,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 1 }]],
      waves: [],
    });
    const provider = fakeProviderWithState({
      labelsById: new Map([[1, ['agent::ready']]]),
      stateById: new Map([[1, 'closed']]),
    });

    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
      },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
  });
});
