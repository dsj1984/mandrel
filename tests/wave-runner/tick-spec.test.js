/**
 * tests/wave-runner/tick-spec.test.js — spec-aware wave grouping coverage.
 *
 * Locks in the contract added by Story #1500:
 *   - `tick({ epic, spec, state })` reads wave numbers from
 *     `spec.stories[].wave` and dispatches the spec-derived grouping.
 *   - `tick({ epic })` (spec omitted) is byte-identical to the
 *     pre-Story-#1500 behaviour — the regression assertion compares the
 *     spec-less result against the original checkpoint-driven plan.
 *   - `groupByWave(spec, state)` is a pure helper exposed for direct
 *     reasoning by the reconciler + dispatcher.
 *
 * Sibling file to `tick.test.js` (which is the existing baseline). The
 * prior file is intentionally left untouched so its assertions continue
 * to lock in the spec-less path verbatim — see the regression case
 * below, which re-asserts the same wave-complete decision under the
 * spec-absent code path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import {
  groupByWave,
  tick,
} from '../../.agents/scripts/lib/wave-runner/tick.js';

/**
 * Fixed-state checkpointer used by the spec-driven cases. Carries an
 * empty `plan: [[]]` to make it obvious which side of the route is
 * responsible for the grouping the assertion targets — if the route
 * accidentally falls through to the checkpoint plan, the wave will be
 * empty and the test fails with a clear `wave-complete` decision.
 */
function fakeCheckpointer(state) {
  return { read: async () => state };
}

/**
 * Fake provider with `getTicket(id)` returning labels from the supplied
 * map. Mirrors `tick.test.js`'s helper so the two files behave
 * identically against the same provider surface.
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

function captureSignals() {
  const emitted = [];
  return {
    emitted,
    signalEmit: async (signal) => emitted.push(signal),
  };
}

describe('lib/wave-runner/tick — groupByWave (pure helper)', () => {
  it('buckets stories by wave with slug → issueNumber mapping', () => {
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'b', title: 'B', wave: 1 },
            { slug: 'c', title: 'C', wave: 0 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 101 },
        b: { issueNumber: 102 },
        c: { issueNumber: 103 },
      },
    };
    const plan = groupByWave(spec, state);
    assert.equal(plan.length, 2);
    assert.deepEqual(
      plan[0].map((s) => s.id),
      [101, 103],
    );
    assert.deepEqual(
      plan[1].map((s) => s.id),
      [102],
    );
    // Slug + title carried through.
    assert.equal(plan[0][0].slug, 'a');
    assert.equal(plan[0][0].title, 'A');
  });

  it('emits empty arrays for waves with no stories between 0 and max', () => {
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'c', title: 'C', wave: 2 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 1 },
        c: { issueNumber: 3 },
      },
    };
    const plan = groupByWave(spec, state);
    assert.equal(plan.length, 3);
    assert.equal(plan[0].length, 1);
    assert.equal(plan[1].length, 0);
    assert.equal(plan[2].length, 1);
  });

  it('walks multiple features in declaration order', () => {
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'b', title: 'B', wave: 0 },
          ],
        },
        {
          slug: 'f2',
          stories: [{ slug: 'c', title: 'C', wave: 0 }],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 1 },
        b: { issueNumber: 2 },
        c: { issueNumber: 3 },
      },
    };
    const plan = groupByWave(spec, state);
    assert.deepEqual(
      plan[0].map((s) => s.id),
      [1, 2, 3],
    );
  });

  it('skips slugs that have no resolved issueNumber in state', () => {
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'b', title: 'B', wave: 0 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 101 },
        // `b` is not yet materialised — reconciler hasn't created it.
      },
    };
    const plan = groupByWave(spec, state);
    assert.equal(plan.length, 1);
    assert.deepEqual(
      plan[0].map((s) => s.id),
      [101],
    );
  });

  it('returns [] when no Story declares a wave', () => {
    const spec = { features: [{ slug: 'f1', stories: [] }] };
    const plan = groupByWave(spec, { mapping: {} });
    assert.deepEqual(plan, []);
  });

  it('tolerates a missing state argument (returns [])', () => {
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [{ slug: 'a', title: 'A', wave: 0 }],
        },
      ],
    };
    assert.deepEqual(groupByWave(spec), []);
    assert.deepEqual(groupByWave(spec, null), []);
  });

  it('tolerates malformed entries (non-integer wave, missing slug)', () => {
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'b', title: 'B', wave: 'one' }, // non-integer → dropped
            { title: 'no-slug', wave: 0 }, // missing slug → dropped
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 1 },
      },
    };
    const plan = groupByWave(spec, state);
    assert.equal(plan.length, 1);
    assert.deepEqual(
      plan[0].map((s) => s.id),
      [1],
    );
  });
});

describe('lib/wave-runner/tick — spec-driven dispatch', () => {
  it('dispatches the spec-derived wave when spec + state are supplied', async () => {
    // Checkpoint plan is intentionally empty — if route picks GH path,
    // dispatch would be empty and the assertion below fails.
    const checkpointer = fakeCheckpointer({
      currentWave: 0,
      totalWaves: 999,
      plan: [[]],
      waves: [],
    });
    const provider = fakeProvider(
      new Map([
        [101, ['agent::ready']],
        [102, ['agent::ready']],
      ]),
    );
    const sig = captureSignals();
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'b', title: 'B', wave: 0 },
            { slug: 'c', title: 'C', wave: 1 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 101 },
        b: { issueNumber: 102 },
        c: { issueNumber: 103 },
      },
    };

    const result = await tick({
      epic: 100,
      spec,
      state,
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [101, 102],
    );
    // totalWaves reflects the spec, not the stale checkpoint.
    assert.equal(result.totalWaves, 2);
    assert.equal(result.currentWave, 0);
  });

  it('advances to wave 1 with spec when wave 0 is fully done', async () => {
    const checkpointer = fakeCheckpointer({
      currentWave: 1,
      totalWaves: 999,
      plan: [[]],
      waves: [{ index: 0, status: 'complete' }],
    });
    const provider = fakeProvider(new Map([[103, ['agent::ready']]]));
    const sig = captureSignals();
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'c', title: 'C', wave: 1 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 101 },
        c: { issueNumber: 103 },
      },
    };

    const result = await tick({
      epic: 100,
      spec,
      state,
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [103],
    );
    assert.equal(result.currentWave, 1);
    assert.equal(result.totalWaves, 2);
  });

  it('returns epic-complete when spec-derived wave count is reached', async () => {
    const checkpointer = fakeCheckpointer({
      currentWave: 2,
      totalWaves: 999,
      plan: [[]],
      waves: [
        { index: 0, status: 'complete' },
        { index: 1, status: 'complete' },
      ],
    });
    const provider = fakeProvider();
    const sig = captureSignals();
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'c', title: 'C', wave: 1 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 101 },
        c: { issueNumber: 103 },
      },
    };

    const result = await tick({
      epic: 100,
      spec,
      state,
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.equal(result.totalWaves, 2);
    assert.ok(sig.emitted.some((e) => e.kind === 'epic-complete'));
  });

  it('returns observe with blocked stories from spec-derived wave', async () => {
    const checkpointer = fakeCheckpointer({
      currentWave: 0,
      totalWaves: 999,
      plan: [[]],
      waves: [],
    });
    const provider = fakeProvider(
      new Map([
        [101, [AGENT_LABELS.DONE]],
        [102, [AGENT_LABELS.BLOCKED]],
      ]),
    );
    const sig = captureSignals();
    const spec = {
      features: [
        {
          slug: 'f1',
          stories: [
            { slug: 'a', title: 'A', wave: 0 },
            { slug: 'b', title: 'B', wave: 0 },
          ],
        },
      ],
    };
    const state = {
      mapping: {
        a: { issueNumber: 101 },
        b: { issueNumber: 102 },
      },
    };

    const result = await tick({
      epic: 100,
      spec,
      state,
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [102]);
    assert.equal(result.blockedStories.length, 1);
    assert.equal(result.blockedStories[0].storyId, 102);
  });
});

describe('lib/wave-runner/tick — spec-absent regression parity', () => {
  /**
   * Regression assertion: with `spec` omitted, `tick` MUST return the
   * same `nextAction` it would have returned before Story #1500. We
   * verify this by driving an identical scenario through the spec-less
   * path and comparing against the documented baseline behaviour from
   * `tick.test.js`.
   */
  it('spec-omitted: dispatches the checkpoint plan unchanged', async () => {
    const checkpointer = fakeCheckpointer({
      currentWave: 0,
      totalWaves: 1,
      plan: [
        [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
        ],
      ],
      waves: [],
    });
    const provider = fakeProvider(
      new Map([
        [1, ['agent::ready']],
        [2, ['agent::ready']],
      ]),
    );
    const sig = captureSignals();

    const result = await tick({
      epic: 100,
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
    assert.equal(result.totalWaves, 1);
    assert.equal(result.currentWave, 0);
  });

  it('spec-omitted: wave-complete decision is byte-identical to the baseline', async () => {
    // Same scenario as tick.test.js "returns wave-complete on full wave
    // done (not last wave)". Re-asserting it from the new test file
    // makes the regression invariant locally visible.
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
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'wave-complete');
    assert.equal(result.nextAction.index, 0);
    assert.equal(result.totalWaves, 2);
    assert.ok(sig.emitted.some((e) => e.kind === 'wave-complete'));
  });

  it('spec-omitted: epic-complete decision matches baseline', async () => {
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
      collaborators: { provider, checkpointer, signalEmit: sig.signalEmit },
    });

    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.equal(result.totalWaves, 2);
    assert.ok(sig.emitted.some((e) => e.kind === 'epic-complete'));
  });
});
