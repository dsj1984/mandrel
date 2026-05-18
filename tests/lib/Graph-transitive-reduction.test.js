// tests/lib/Graph-transitive-reduction.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeReachability,
  transitiveReduction,
} from '../../.agents/scripts/lib/Graph.js';

/**
 * Legacy reference implementation of transitiveReduction, preserved here
 * verbatim so we can assert byte-identical output across multiple graph
 * shapes after the O(V+E) rewrite.
 *
 * @param {Map<*, *[]>} adjacency
 * @returns {Map<*, *[]>}
 */
function legacyTransitiveReduction(adjacency) {
  const result = new Map();

  for (const [node, deps] of adjacency.entries()) {
    if (deps.length <= 1) {
      result.set(node, [...deps]);
      continue;
    }

    const kept = [];
    for (const dep of deps) {
      const isRedundant = deps.some((other) => {
        if (other === dep) return false;
        return legacyDfsReaches(other, dep, adjacency, new Set([node]));
      });
      if (!isRedundant) kept.push(dep);
    }
    result.set(node, kept);
  }

  return result;
}

function legacyDfsReaches(start, target, adjacency, visited) {
  if (start === target) return true;
  visited.add(start);
  for (const neighbour of adjacency.get(start) || []) {
    if (!visited.has(neighbour)) {
      if (legacyDfsReaches(neighbour, target, adjacency, visited)) return true;
    }
  }
  return false;
}

/**
 * Normalize an adjacency Map so two maps with identical content but
 * different key-iteration / array order compare byte-identical.
 *
 * @param {Map<*, *[]>} adj
 */
function normalizeAdjacency(adj) {
  const entries = [...adj.entries()]
    .map(([node, deps]) => [node, [...deps].sort(cmp)])
    .sort(([a], [b]) => cmp(a, b));
  return entries;
}

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Fixture A — chain with shortcuts: 20-node chain 1 → 2 → … → 20 plus
 * a direct edge from 1 to every j > 1. Every shortcut is redundant.
 */
function buildChainWithShortcuts() {
  const adj = new Map();
  for (let i = 1; i <= 20; i++) {
    if (i === 20) {
      adj.set(i, []);
    } else if (i === 1) {
      // 1 has a direct edge to every higher node
      adj.set(i, Array.from({ length: 19 }, (_, k) => k + 2));
    } else {
      adj.set(i, [i + 1]);
    }
  }
  return adj;
}

/**
 * Fixture B — dense layered DAG: 4 layers of 5 nodes each, every node
 * in layer L points at every node in layer L+1 AND every node in
 * layer L+2 (every L→L+2 edge is redundant because L→L+1→L+2 exists).
 */
function buildDenseLayered() {
  const adj = new Map();
  const layers = [
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10],
    [11, 12, 13, 14, 15],
    [16, 17, 18, 19, 20],
  ];
  for (let l = 0; l < layers.length; l++) {
    for (const node of layers[l]) {
      const deps = [];
      if (l + 1 < layers.length) deps.push(...layers[l + 1]);
      if (l + 2 < layers.length) deps.push(...layers[l + 2]);
      adj.set(node, deps);
    }
  }
  return adj;
}

/**
 * Fixture C — diamond cascade: 20 nodes arranged as overlapping diamonds.
 * Node i (1..18) points to i+1 and i+2; node i+1 points to i+2. Many
 * (i → i+2) edges are redundant via (i → i+1 → i+2).
 */
function buildDiamondCascade() {
  const adj = new Map();
  for (let i = 1; i <= 20; i++) {
    const deps = [];
    if (i + 1 <= 20) deps.push(i + 1);
    if (i + 2 <= 20) deps.push(i + 2);
    adj.set(i, deps);
  }
  return adj;
}

const fixtures = [
  ['chain-with-shortcuts (20 nodes)', buildChainWithShortcuts],
  ['dense-layered DAG (4×5 = 20 nodes)', buildDenseLayered],
  ['diamond cascade (20 nodes)', buildDiamondCascade],
];

for (const [label, build] of fixtures) {
  test(`transitiveReduction: ${label} — single-arg matches legacy`, () => {
    const adj = build();
    const expected = legacyTransitiveReduction(adj);
    const actual = transitiveReduction(adj);
    assert.deepStrictEqual(
      normalizeAdjacency(actual),
      normalizeAdjacency(expected),
      `legacy and rewrite disagree on ${label} (single-arg)`,
    );
  });

  test(`transitiveReduction: ${label} — pre-computed reachability matches legacy`, () => {
    const adj = build();
    const reachable = computeReachability(adj);
    const expected = legacyTransitiveReduction(adj);
    const actual = transitiveReduction(adj, reachable);
    assert.deepStrictEqual(
      normalizeAdjacency(actual),
      normalizeAdjacency(expected),
      `legacy and rewrite disagree on ${label} (two-arg)`,
    );
  });

  test(`transitiveReduction: ${label} — single-arg and two-arg are identical`, () => {
    const adj = build();
    const reachable = computeReachability(adj);
    const noArg = transitiveReduction(adj);
    const withArg = transitiveReduction(adj, reachable);
    assert.deepStrictEqual(
      normalizeAdjacency(noArg),
      normalizeAdjacency(withArg),
      `two forms disagree on ${label}`,
    );
  });
}

test('transitiveReduction: chain-with-shortcuts reduces to a simple chain', () => {
  // Sanity check on a known-correct shape: after reduction, node 1
  // should only point to node 2 (every other edge is redundant via
  // the chain).
  const adj = buildChainWithShortcuts();
  const reduced = transitiveReduction(adj);
  assert.deepStrictEqual(reduced.get(1), [2]);
});

test('transitiveReduction: dense-layered keeps L→L+1 and drops L→L+2', () => {
  const adj = buildDenseLayered();
  const reduced = transitiveReduction(adj);
  // Node 1 (layer 0) points to layer 1 only after reduction.
  assert.deepStrictEqual([...reduced.get(1)].sort(cmp), [6, 7, 8, 9, 10]);
  // Last layer keeps empty deps.
  assert.deepStrictEqual(reduced.get(20), []);
});
