/**
 * tests/contract/delivery/three-tier-dispatch.test.js
 *
 * Contract: dispatch wave computation for a 3-tier Epic. The dispatch
 * layer (`isThreeTierDispatch` + `buildStoryDispatchGraph` in
 * `.agents/scripts/lib/orchestration/dispatch-pipeline.js`) MUST detect a
 * Story-only ticket graph, refuse to invoke the Task-centric grouping
 * pipeline, and emit Story-level execution waves that honour
 * cross-Story `blocked by` dependencies.
 *
 * Asserts:
 *   - `isThreeTierDispatch` returns true when explicit hierarchy is
 *     `'3-tier'` regardless of ticket shape.
 *   - `isThreeTierDispatch` returns true for auto-detection when there
 *     are zero Tasks and at least one Story.
 *   - `isThreeTierDispatch` returns false when any Task is present (even
 *     when Stories also exist) and hierarchy is not pinned.
 *   - `isThreeTierDispatch` honours `hierarchy === '4-tier'` and refuses
 *     the 3-tier path even with a Story-only graph.
 *   - `buildStoryDispatchGraph` computes the expected Story-level wave
 *     ordering when Story B is `blocked by #<storyA-id>`.
 *   - `buildStoryDispatchGraph` places independent Stories in wave 0
 *     together (parallel-by-default).
 *
 * Story #3136 (Epic #3078, Feature #3093). The companion enforcement
 * test at tests/enforcement/manifest-schema.test.js covers
 * `buildManifest()` shape; this contract test pins the upstream wave
 * computation that feeds it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildStoryDispatchGraph,
  isThreeTierDispatch,
} from '../../../.agents/scripts/lib/orchestration/dispatch-pipeline.js';

function storyTicket(id, { dependsOnIds = [], extraLabels = [] } = {}) {
  const blockedByLines = dependsOnIds.map((d) => `blocked by #${d}`).join('\n');
  return {
    id,
    title: `Story ${id}`,
    body: blockedByLines,
    labels: ['type::story', ...extraLabels],
  };
}

function taskTicket(id) {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    labels: ['type::task'],
  };
}

describe('isThreeTierDispatch — hierarchy detection (Story #3136)', () => {
  it('returns true when hierarchy is explicitly "3-tier" (overrides shape)', () => {
    // Arrange — even a graph with Tasks present is forced to 3-tier when
    // operator pins the hierarchy.
    const tasks = [taskTicket(1)];
    const allTickets = [storyTicket(100), taskTicket(1)];

    // Act
    const result = isThreeTierDispatch(tasks, allTickets, '3-tier');

    // Assert
    assert.equal(result, true);
  });

  it('returns true via auto-detection when there are zero Tasks and at least one Story', () => {
    // Arrange
    const tasks = [];
    const allTickets = [storyTicket(100), storyTicket(101)];

    // Act
    const result = isThreeTierDispatch(tasks, allTickets, undefined);

    // Assert
    assert.equal(result, true);
  });

  it('returns false when any Task is present and hierarchy is not pinned', () => {
    // Arrange
    const tasks = [taskTicket(1)];
    const allTickets = [storyTicket(100), taskTicket(1)];

    // Act
    const result = isThreeTierDispatch(tasks, allTickets, undefined);

    // Assert
    assert.equal(result, false);
  });

  it('returns false when hierarchy is explicitly "4-tier" (overrides Story-only shape)', () => {
    // Arrange — Story-only graph that auto-detect would route to 3-tier;
    // explicit "4-tier" must beat the heuristic.
    const tasks = [];
    const allTickets = [storyTicket(100), storyTicket(101)];

    // Act
    const result = isThreeTierDispatch(tasks, allTickets, '4-tier');

    // Assert
    assert.equal(result, false);
  });

  it('returns false on an empty ticket graph', () => {
    // Arrange / Act
    const result = isThreeTierDispatch([], [], undefined);

    // Assert
    assert.equal(result, false);
  });
});

describe('buildStoryDispatchGraph — Story-level wave computation (Story #3136)', () => {
  it('places independent Stories together in wave 0', () => {
    // Arrange
    const stories = [storyTicket(100), storyTicket(101), storyTicket(102)];

    // Act
    const { allWaves, storyMap } = buildStoryDispatchGraph(stories);

    // Assert
    assert.equal(allWaves.length, 1);
    const wave0Ids = allWaves[0].map((s) => s.id).sort();
    assert.deepEqual(wave0Ids, [100, 101, 102]);
    assert.equal(storyMap.size, 3);
    assert.equal(storyMap.get(100).title, 'Story 100');
  });

  it('orders dependent Stories into successive waves via `blocked by` body markers', () => {
    // Arrange — Story B (101) depends on Story A (100); Story C (102)
    // depends on Story B. The dispatch graph must place A in wave 0,
    // B in wave 1, and C in wave 2.
    const stories = [
      storyTicket(100),
      storyTicket(101, { dependsOnIds: [100] }),
      storyTicket(102, { dependsOnIds: [101] }),
    ];

    // Act
    const { allWaves } = buildStoryDispatchGraph(stories);

    // Assert
    assert.equal(allWaves.length, 3);
    assert.deepEqual(
      allWaves[0].map((s) => s.id),
      [100],
    );
    assert.deepEqual(
      allWaves[1].map((s) => s.id),
      [101],
    );
    assert.deepEqual(
      allWaves[2].map((s) => s.id),
      [102],
    );
  });

  it('mixes independent + dependent Stories across the correct waves', () => {
    // Arrange — A and C are independent (wave 0); B depends on A
    // (wave 1). C must stay in wave 0 alongside A.
    const stories = [
      storyTicket(100),
      storyTicket(101, { dependsOnIds: [100] }),
      storyTicket(102),
    ];

    // Act
    const { allWaves } = buildStoryDispatchGraph(stories);

    // Assert
    assert.equal(allWaves.length, 2);
    const wave0Ids = allWaves[0].map((s) => s.id).sort();
    assert.deepEqual(wave0Ids, [100, 102]);
    assert.deepEqual(
      allWaves[1].map((s) => s.id),
      [101],
    );
  });

  it('returns an empty wave list for an empty Story set', () => {
    // Arrange / Act
    const { allWaves, storyMap } = buildStoryDispatchGraph([]);

    // Assert
    assert.deepEqual(allWaves, []);
    assert.equal(storyMap.size, 0);
  });
});
