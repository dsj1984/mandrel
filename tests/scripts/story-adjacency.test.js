/**
 * tests/scripts/story-adjacency.test.js — shared story-level adjacency builder.
 *
 * Locks in the Story #4020 contract:
 *   - `lib/story-adjacency.js#buildStoryAdjacency` is the single home for
 *     turning Story records into the `Map<storyId, deps[]>` shape the
 *     `lib/Graph.js` kernel consumes.
 *   - All three wave-computation wrappers (`build-wave-dag.js`,
 *     `dispatch-pipeline.js#buildStoryDispatchGraph`,
 *     `stories-wave-tick.js`) consume it and produce identical wave
 *     numbering for the same representative dependency DAG.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeWaves } from '../../.agents/scripts/lib/Graph.js';
import { buildStoryDispatchGraph } from '../../.agents/scripts/lib/orchestration/dispatch-pipeline.js';
import { runBuildWaveDagPhase } from '../../.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { buildStoryAdjacency } from '../../.agents/scripts/lib/story-adjacency.js';
import {
  buildAdjacency,
  computeStoriesWavePlan,
} from '../../.agents/scripts/stories-wave-tick.js';

/**
 * Representative DAG (diamond + isolated root + chain tail):
 *
 *   101 ─┬─> 102 ─┬─> 104 ──> 105
 *        └─> 103 ─┘
 *   106 (isolated)
 *
 * Expected waves: [101, 106], [102, 103], [104], [105]
 */
const EXPECTED_WAVES = [[101, 106], [102, 103], [104], [105]];

function ticketStories() {
  return [
    { id: 101, labels: ['type::story'], state: 'open', body: 'Root story.' },
    {
      id: 102,
      labels: ['type::story'],
      state: 'open',
      body: 'Blocked by #101.',
    },
    {
      id: 103,
      labels: ['type::story'],
      state: 'open',
      body: 'No body ref.',
      dependencies: [101],
    },
    {
      id: 104,
      labels: ['type::story'],
      state: 'open',
      body: 'Blocked by #102.',
      dependencies: [103],
    },
    {
      id: 105,
      labels: ['type::story'],
      state: 'open',
      body: 'Depends on #104.',
    },
    { id: 106, labels: ['type::story'], state: 'open', body: 'Isolated.' },
  ];
}

function dagNodes() {
  return [
    { id: 101, dependsOn: [] },
    { id: 102, dependsOn: [101] },
    { id: 103, dependsOn: [101] },
    { id: 104, dependsOn: [102, 103] },
    { id: 105, dependsOn: [104] },
    { id: 106, dependsOn: [] },
  ];
}

function sortedWaves(waves) {
  return waves.map((w) => [...w].sort((a, b) => a - b));
}

describe('lib/story-adjacency — buildStoryAdjacency', () => {
  it('merges body blocked-by refs with explicit dependencies, deduped', () => {
    const adjacency = buildStoryAdjacency([
      { id: 1, body: '' },
      { id: 2, body: 'blocked by #1', dependencies: [1] },
    ]);
    assert.deepEqual(adjacency.get(2), [1]);
  });

  it('drops self-edges and foreign ids by default', () => {
    const adjacency = buildStoryAdjacency([
      { id: 1, body: 'blocked by #1', dependencies: [99] },
      { id: 2, dependencies: [1, 2, 500] },
    ]);
    assert.deepEqual(adjacency.get(1), []);
    assert.deepEqual(adjacency.get(2), [1]);
  });

  it('keeps foreign ids when dropForeign is false (operator-DAG contract)', () => {
    const adjacency = buildStoryAdjacency([{ id: 1, dependsOn: [99] }], {
      dropForeign: false,
    });
    assert.deepEqual(adjacency.get(1), [99]);
  });

  it('accepts dependsOn (operator-DAG shape) and number (ticket shape) keys', () => {
    const adjacency = buildStoryAdjacency([
      { number: 7, body: '' },
      { id: 8, dependsOn: [7] },
    ]);
    assert.deepEqual(adjacency.get(8), [7]);
    assert.deepEqual(adjacency.get(7), []);
  });
});

describe('lib/story-adjacency — wave-numbering parity across the three wrappers', () => {
  it('build-wave-dag (computeWaves) produces the expected waves', async () => {
    const stories = ticketStories();
    const provider = {
      async getSubTickets(id) {
        return id === 1 ? stories : [];
      },
    };
    const state = await runBuildWaveDagPhase({ epicId: 1, provider }, {}, {});
    const waves = state.waves.map((w) => w.map((t) => t.id));
    assert.deepEqual(sortedWaves(waves), EXPECTED_WAVES);
  });

  it('dispatch-pipeline (buildStoryDispatchGraph) produces the expected waves', () => {
    const { allWaves } = buildStoryDispatchGraph(ticketStories());
    const waves = allWaves.map((w) => w.map((t) => t.id));
    assert.deepEqual(sortedWaves(waves), EXPECTED_WAVES);
  });

  it('stories-wave-tick (computeStoriesWavePlan) produces the expected waves', () => {
    const plan = computeStoriesWavePlan(buildAdjacency(dagNodes()), 3);
    assert.equal(plan.cycleError, null);
    assert.deepEqual(
      plan.waves.map((w) => w.stories),
      EXPECTED_WAVES,
    );
  });

  it('shared builder output matches the historical per-wrapper inline adjacency', () => {
    // Reference re-implementation of the pre-#4020 inline builder the
    // wrappers each carried — proves the extraction is behavior-preserving.
    const stories = ticketStories();
    const reference = new Map();
    const ids = new Set(stories.map((s) => s.id));
    for (const s of stories) {
      const fromBody = (s.body ?? '').match(/#(\d+)/g) ?? [];
      const parsed = fromBody.map((m) => Number(m.slice(1)));
      const fromField = Array.isArray(s.dependencies) ? s.dependencies : [];
      reference.set(
        s.id,
        [...new Set([...parsed, ...fromField])].filter(
          (d) => d !== s.id && ids.has(d),
        ),
      );
    }
    const shared = buildStoryAdjacency(stories);
    const wavesRef = computeWaves(
      reference,
      new Map(stories.map((s) => [s.id, s])),
    ).map((w) => w.map((t) => t.id));
    const wavesShared = computeWaves(
      shared,
      new Map(stories.map((s) => [s.id, s])),
    ).map((w) => w.map((t) => t.id));
    assert.deepEqual(sortedWaves(wavesShared), sortedWaves(wavesRef));
    assert.deepEqual(sortedWaves(wavesShared), EXPECTED_WAVES);
  });
});
