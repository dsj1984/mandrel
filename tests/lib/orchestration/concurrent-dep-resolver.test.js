import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGraph,
  computeReachability,
} from '../../../.agents/scripts/lib/Graph.js';
import { autoSerializeOverlaps } from '../../../.agents/scripts/lib/orchestration/concurrent-dep-resolver.js';

test('concurrent-dep-resolver: autoSerializeOverlaps basic', () => {
  const tasks = [
    { id: 1, focusAreas: ['A'], dependsOn: [], scope: 'file' },
    { id: 2, focusAreas: ['A'], dependsOn: [], scope: 'file' },
  ];
  const { adjacency } = buildGraph(tasks);
  const manifest = { tasks };

  const { finalAdjacency, graphMutated } = autoSerializeOverlaps(
    manifest,
    adjacency,
  );

  assert.ok(graphMutated);
  assert.deepEqual(tasks[1].dependsOn, [1]);
  assert.ok(finalAdjacency.get(2).includes(1));
});

test('concurrent-dep-resolver: autoSerializeOverlaps no overlap', () => {
  const tasks = [
    { id: 1, focusAreas: ['A'], dependsOn: [], scope: 'file' },
    { id: 2, focusAreas: ['B'], dependsOn: [], scope: 'file' },
  ];
  const { adjacency } = buildGraph(tasks);
  const manifest = { tasks };

  const { finalAdjacency: _finalAdjacency, graphMutated } =
    autoSerializeOverlaps(manifest, adjacency);

  assert.ok(!graphMutated);
  assert.deepEqual(tasks[1].dependsOn, []);
});

test('concurrent-dep-resolver: autoSerializeOverlaps avoids duplicates', () => {
  const tasks = [
    { id: 1, focusAreas: ['A'], dependsOn: [], scope: 'file' },
    { id: 2, focusAreas: ['A'], dependsOn: [1], scope: 'file' },
  ];
  const { adjacency } = buildGraph(tasks);
  const manifest = { tasks };

  const { finalAdjacency: _finalAdjacency, graphMutated } =
    autoSerializeOverlaps(manifest, adjacency);

  assert.ok(!graphMutated);
  assert.deepEqual(tasks[1].dependsOn, [1]);
});

test('concurrent-dep-resolver: autoSerializeOverlaps multiple overlaps', () => {
  const tasks = [
    { id: 1, focusAreas: ['A'], dependsOn: [], scope: 'file' },
    { id: 2, focusAreas: ['A', 'B'], dependsOn: [], scope: 'file' },
    { id: 3, focusAreas: ['B'], dependsOn: [], scope: 'file' },
  ];
  const { adjacency } = buildGraph(tasks);
  const manifest = { tasks };

  const { finalAdjacency: _finalAdjacency, graphMutated } =
    autoSerializeOverlaps(manifest, adjacency);

  assert.ok(graphMutated);
  // 1 and 2 overlap on A -> 2 dependsOn 1
  // 1 and 3 don't overlap
  // 2 and 3 overlap on B -> 3 dependsOn 2
  assert.ok(tasks[0].dependsOn.length === 0);
  assert.deepEqual(tasks[0].dependsOn, []);
  assert.deepEqual(tasks[1].dependsOn, [1]);
  assert.deepEqual(tasks[2].dependsOn, [2]);
});

test('concurrent-dep-resolver: autoSerializeOverlaps reuses a pre-computed reachability matrix', () => {
  // When the caller has already computed reachability, the resolver should
  // honour it rather than triggering another O(V·(V+E)) traversal. We prove
  // this by passing a sentinel matrix where A→B is already reachable,
  // suppressing the edge that would otherwise be emitted from focus overlap.
  const tasks = [
    { id: 1, focusAreas: ['A'], dependsOn: [], scope: 'file' },
    { id: 2, focusAreas: ['A'], dependsOn: [], scope: 'file' },
  ];
  const { adjacency } = buildGraph(tasks);
  const sentinel = new Map([
    [1, new Set([2])],
    [2, new Set()],
  ]);

  const { graphMutated, reachable } = autoSerializeOverlaps(
    { tasks },
    adjacency,
    { reachable: sentinel },
  );

  assert.equal(graphMutated, false, 'sentinel should suppress new edge');
  assert.equal(tasks[1].dependsOn.length, 0);
  assert.strictEqual(reachable, sentinel, 'reachable is echoed back');
});

test('concurrent-dep-resolver: bucketed overlap matches the naive pairwise result', () => {
  // Sanity-check that the focus-area bucketing in _collectPendingEdges
  // produces the same edges the previous O(n²) pairwise scan would have.
  const tasks = [
    { id: 1, focusAreas: ['A'], dependsOn: [], scope: 'file' },
    { id: 2, focusAreas: ['A', 'B'], dependsOn: [], scope: 'file' },
    { id: 3, focusAreas: ['B', 'C'], dependsOn: [], scope: 'file' },
    { id: 4, focusAreas: ['D'], dependsOn: [], scope: 'file' },
    { id: 5, focusAreas: [], dependsOn: [], scope: 'root' },
  ];
  const { adjacency } = buildGraph(tasks);

  // Expected pairs (lower-index-first):
  //   1↔2 (A), 2↔3 (B), 5↔everyone (scope: root)
  autoSerializeOverlaps({ tasks }, adjacency, {
    reachable: computeReachability(adjacency),
  });

  assert.deepEqual(tasks[1].dependsOn, [1]); // 2 depends on 1
  assert.deepEqual(tasks[2].dependsOn, [2]); // 3 depends on 2
  assert.deepEqual(tasks[3].dependsOn, []); // 4 has no overlap
  // 5 is globally-scoped → paired with 1, 2, 3, 4 (5's own id is higher)
  assert.deepEqual(
    [...tasks[4].dependsOn].sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
});
