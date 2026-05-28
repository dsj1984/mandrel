/**
 * tests/contract/delivery/three-tier-dispatch.test.js
 *
 * Contract: dispatch wave computation for a 3-tier Epic. After Epic #3163's
 * hard cutover deleted the `type::task` ticket layer, shape selection is
 * purely structural — any Epic carrying at least one `type::story` ticket
 * resolves to the 3-tier path.
 *
 * Asserts:
 *   - `isThreeTierDispatch` returns true when at least one Story is
 *     present.
 *   - `isThreeTierDispatch` returns false on an empty ticket graph.
 *   - `isThreeTierDispatch` returns false when no Story is present.
 *   - `buildStoryDispatchGraph` computes the expected Story-level wave
 *     ordering when Story B is `blocked by #<storyA-id>`.
 *   - `buildStoryDispatchGraph` places independent Stories in wave 0
 *     together (parallel-by-default).
 *
 * Story #3136 (Epic #3078, Feature #3093). Updated under Story #3193
 * (Epic #3163, Feature #3179) to drop the `tasks` parameter.
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

function nonStoryTicket(id) {
  return {
    id,
    title: `Feature ${id}`,
    body: '',
    labels: ['type::feature'],
  };
}

describe('isThreeTierDispatch — structural detection (Story #3193)', () => {
  it('returns true when at least one Story is present', () => {
    // Arrange
    const allTickets = [storyTicket(100), storyTicket(101)];

    // Act
    const result = isThreeTierDispatch(allTickets);

    // Assert
    assert.equal(result, true);
  });

  it('returns false on an empty ticket graph', () => {
    // Arrange / Act
    const result = isThreeTierDispatch([]);

    // Assert
    assert.equal(result, false);
  });

  it('returns false when no Story is present', () => {
    // Arrange / Act
    const result = isThreeTierDispatch([nonStoryTicket(1)]);

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
