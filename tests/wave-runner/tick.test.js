import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import { tick } from '../../.agents/scripts/lib/wave-runner/tick.js';
import { WaveRunnerError } from '../../.agents/scripts/lib/wave-runner/wave-runner-error.js';

/**
 * tests/wave-runner/tick.test.js — the Epic `/deliver` tick is a thin
 * adapter over the ready-set core (`lib/wave-runner/ready-set.js`). These
 * tests pin the adapter contract: the checkpoint contributes only the Story
 * set + the global in-flight cap, readiness is re-derived from live labels +
 * bodies on every beat (no wave barrier), and an old-shape (wave-batch)
 * checkpoint fails closed.
 */

/** Fake checkpoint store returning a fixed (per-Story-status shape) state. */
function fakeStore(state) {
  return { read: async () => state };
}

/**
 * Build a per-Story-status checkpoint from a list of Story ids and a global
 * cap. Every Story seeds at `pending` — the live labels drive classification.
 */
function checkpoint(storyIds, { concurrencyCap = 3, extra = {} } = {}) {
  const stories = {};
  for (const id of storyIds) stories[String(id)] = { status: 'pending' };
  return { epicId: 100, concurrencyCap, stories, ...extra };
}

/**
 * Fake provider with `getTicket(id)` returning labels / state / body from the
 * supplied maps. `body` feeds `buildStoryAdjacency` (`blocked by #N`).
 */
function fakeProvider({
  labelsById = new Map(),
  stateById = new Map(),
  bodyById = new Map(),
} = {}) {
  return {
    async getTicket(id) {
      return {
        id,
        labels: labelsById.get(id) ?? [],
        state: stateById.get(id) ?? 'open',
        body: bodyById.get(id) ?? '',
        title: `Story #${id}`,
      };
    },
  };
}

/** Capture emitted signals via a stub `signalEmit`. */
function captureSignals() {
  const emitted = [];
  return { emitted, signalEmit: async (s) => emitted.push(s) };
}

const ready = ['agent::ready', 'type::story'];

describe('lib/wave-runner/tick — ready-set adapter', () => {
  it('dispatches every ready Story under the global cap (no wave barrier)', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, ready],
            [2, ready],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
        signalEmit: captureSignals().signalEmit,
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
    assert.equal(result.readyCount, 2);
  });

  it('AC#1 — dispatches a ready Story whose deps are done even while an unrelated sibling is executing', async () => {
    // Story 3 depends only on Story 1 (done). Story 2 is an unrelated
    // sibling still executing. Under a wave barrier Story 3 would wait for
    // wave-2; under the ready-set core it dispatches now.
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.DONE]],
            [2, [AGENT_LABELS.EXECUTING]],
            [3, ready],
          ]),
          bodyById: new Map([[3, 'Depends on the first.\n\nblocked by #1']]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2, 3])),
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [3],
    );
  });

  it('withholds a ready Story whose dependency is not yet done', async () => {
    // Story 2 depends on Story 1, which is still executing → not dispatchable.
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.EXECUTING]],
            [2, ready],
          ]),
          bodyById: new Map([[2, 'blocked by #1']]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
      },
    });
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [1]);
  });

  it('caps the dispatch set at the global concurrencyCap minus in-flight', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, ready],
            [2, ready],
            [3, ready],
            [4, ready],
          ]),
        }),
        epicRunStateStore: fakeStore(
          checkpoint([1, 2, 3, 4], { concurrencyCap: 2 }),
        ),
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    // globalCap 2, nothing in flight → at most 2 dispatched (ascending id).
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
  });

  it('subtracts ledger in-flight Stories from remaining capacity', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, ready],
            [2, ready],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2], { concurrencyCap: 2 })),
        // Story 1 already dispatched (ledger), label not yet flipped: one slot
        // consumed → only one more may dispatch this beat.
        inFlightReader: async () => [1],
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
    assert.deepEqual(result.nextAction['in-flight'], [1]);
  });

  it('withholds an overlapping Story (file-footprint co-dispatch guard)', async () => {
    // Both ready, no deps, but share a declared file → only one dispatches.
    const provider = {
      async getTicket(id) {
        const files = ['lib/x.js'];
        return { id, labels: ready, state: 'open', body: '', files };
      },
    };
    const result = await tick({
      epic: 100,
      collaborators: {
        provider,
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    // Lower id wins admission; the overlapping peer is withheld this beat.
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1],
    );
  });

  it('returns observe + blockedStories when any Story is agent::blocked', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.DONE]],
            [2, [AGENT_LABELS.BLOCKED]],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
      },
    });
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [2]);
    assert.equal(result.blockedStories.length, 1);
    assert.equal(result.blockedStories[0].storyId, 2);
    assert.equal(result.blockedStories[0].reason, 'agent::blocked');
  });

  it('observes while a Story is executing (nothing else ready)', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.DONE]],
            [2, [AGENT_LABELS.EXECUTING]],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
      },
    });
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [2]);
  });

  it('returns epic-complete when every Story is done', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.DONE]],
            [2, [AGENT_LABELS.DONE]],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
      },
    });
    assert.equal(result.nextAction.kind, 'epic-complete');
  });

  it('treats a manually-closed Story (state=closed, no agent::done) as done', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, ['agent::ready']],
            [2, ['agent::ready']],
          ]),
          stateById: new Map([
            [1, 'closed'],
            [2, 'open'],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
  });

  it('emits wave-start once on the run-opening dispatch and never the retired events', async () => {
    const sig = captureSignals();
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, ready],
            [2, ready],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
        signalEmit: sig.signalEmit,
      },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.ok(sig.emitted.some((e) => e.kind === 'wave-start'));
    assert.equal(
      sig.emitted.some((e) => e.kind === 'wave-tick'),
      false,
    );
    assert.equal(
      sig.emitted.some((e) => e.kind === 'epic-complete'),
      false,
    );
  });

  it('does NOT re-emit wave-start when work is already in progress', async () => {
    const sig = captureSignals();
    // Story 1 done, Story 2 ready → a dispatch, but not the run-opening one.
    await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.DONE]],
            [2, ready],
          ]),
        }),
        epicRunStateStore: fakeStore(checkpoint([1, 2])),
        signalEmit: sig.signalEmit,
      },
    });
    assert.equal(
      sig.emitted.some((e) => e.kind === 'wave-start'),
      false,
    );
  });

  it('surfaces failed Stories recorded on the checkpoint as gateFailures', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider({
          labelsById: new Map([
            [1, [AGENT_LABELS.DONE]],
            [2, [AGENT_LABELS.DONE]],
          ]),
        }),
        epicRunStateStore: fakeStore(
          checkpoint([1, 2], {
            extra: {
              stories: {
                1: { status: 'done' },
                2: { status: 'failed', title: 'broke the build' },
              },
            },
          }),
        ),
      },
    });
    assert.ok(result.gateFailures.some((g) => g.storyId === 2));
    const g = result.gateFailures.find((x) => x.storyId === 2);
    assert.equal(g.gate, 'unspecified');
    assert.equal(g.detail, 'broke the build');
  });
});

describe('lib/wave-runner/tick — fail-closed guards', () => {
  it('AC#4 — fails closed on an old-shape checkpoint carrying currentWave/plan', async () => {
    await assert.rejects(
      tick({
        epic: 100,
        collaborators: {
          provider: fakeProvider(),
          epicRunStateStore: fakeStore({
            epicId: 100,
            currentWave: 0,
            totalWaves: 2,
            plan: [[{ id: 1 }], [{ id: 2 }]],
            stories: { 1: { status: 'pending' } },
          }),
        },
      }),
      (err) =>
        err instanceof WaveRunnerError &&
        err.phase === 'old-shape-checkpoint' &&
        /currentWave|plan|totalWaves/.test(err.message),
    );
  });

  it('fails closed when only `plan` survives on the checkpoint', async () => {
    await assert.rejects(
      tick({
        epic: 100,
        collaborators: {
          provider: fakeProvider(),
          epicRunStateStore: fakeStore({
            epicId: 100,
            plan: [[{ id: 1 }]],
            stories: { 1: { status: 'pending' } },
          }),
        },
      }),
      (err) =>
        err instanceof WaveRunnerError && err.phase === 'old-shape-checkpoint',
    );
  });

  it('throws checkpoint-missing when no checkpoint exists', async () => {
    await assert.rejects(
      tick({
        epic: 100,
        collaborators: {
          provider: fakeProvider(),
          epicRunStateStore: fakeStore(null),
        },
      }),
      (err) =>
        err instanceof WaveRunnerError && err.phase === 'checkpoint-missing',
    );
  });

  it('throws checkpoint-read when the store read fails', async () => {
    await assert.rejects(
      tick({
        epic: 100,
        collaborators: {
          provider: fakeProvider(),
          epicRunStateStore: {
            read: async () => {
              throw new Error('GH 503');
            },
          },
        },
      }),
      (err) =>
        err instanceof WaveRunnerError && err.phase === 'checkpoint-read',
    );
  });

  it('throws story-fetch when provider.getTicket throws', async () => {
    await assert.rejects(
      tick({
        epic: 100,
        collaborators: {
          provider: {
            async getTicket() {
              throw new Error('rate-limited');
            },
          },
          epicRunStateStore: fakeStore(checkpoint([1])),
        },
      }),
      (err) => err instanceof WaveRunnerError && err.phase === 'story-fetch',
    );
  });

  it('throws invalid-input on a non-positive epic id', async () => {
    await assert.rejects(
      tick({ epic: 0, collaborators: { provider: fakeProvider() } }),
      (err) => err instanceof WaveRunnerError && err.phase === 'invalid-input',
    );
  });

  it('returns epic-complete for a checkpoint with an empty Story set', async () => {
    const result = await tick({
      epic: 100,
      collaborators: {
        provider: fakeProvider(),
        epicRunStateStore: fakeStore({
          epicId: 100,
          concurrencyCap: 3,
          stories: {},
        }),
      },
    });
    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.deepEqual(result.nextAction['in-flight'], []);
  });

  it('accepts both `epic: number` and `epic: { id }` argument shapes', async () => {
    const store = fakeStore(checkpoint([1]));
    const provider = fakeProvider({
      labelsById: new Map([[1, [AGENT_LABELS.DONE]]]),
    });
    const r1 = await tick({
      epic: 100,
      collaborators: { provider, epicRunStateStore: store },
    });
    const r2 = await tick({
      epic: { id: 100 },
      collaborators: { provider, epicRunStateStore: store },
    });
    assert.equal(r1.nextAction.kind, r2.nextAction.kind);
  });
});
