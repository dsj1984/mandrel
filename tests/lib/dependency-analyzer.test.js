import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __test,
  computeStoryWaves,
  isFocusOverlapEdgeEligible,
} from '../../.agents/scripts/lib/orchestration/dependency-analyzer.js';

// ---------------------------------------------------------------------------
// Story-level focus-overlap serialization (v5.5.1)
// ---------------------------------------------------------------------------

function storyGroup(storyId, tasks) {
  return { storyId, storyTitle: `Story ${storyId}`, type: 'story', tasks };
}

test('computeStoryWaves: serializes stories with overlapping focus areas', () => {
  // Two stories with no cross-story dependencies but both touching the
  // same directory should land in different waves.
  const groups = new Map([
    [
      100,
      storyGroup(100, [
        { id: 1001, dependsOn: [], focusAreas: ['apps/api/media'] },
      ]),
    ],
    [
      200,
      storyGroup(200, [
        { id: 2001, dependsOn: [], focusAreas: ['apps/api/media'] },
      ]),
    ],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  // Lower id runs first → story 100 is wave 0, story 200 is wave 1
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 1);
});

test('computeStoryWaves: disjoint focus areas stay in same wave', () => {
  const groups = new Map([
    [100, storyGroup(100, [{ id: 1001, dependsOn: [], focusAreas: ['api'] }])],
    [200, storyGroup(200, [{ id: 2001, dependsOn: [], focusAreas: ['web'] }])],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 0);
});

test('computeStoryWaves: stories without focus areas are not serialized', () => {
  // Missing focus data → should not assume overlap (avoids over-serialization).
  const groups = new Map([
    [100, storyGroup(100, [{ id: 1001, dependsOn: [] }])],
    [200, storyGroup(200, [{ id: 2001, dependsOn: [] }])],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 0);
});

test('computeStoryWaves: global-scope story serializes after all others', () => {
  // Story 300 has a root-scoped task → treated as global, overlaps every
  // other story and runs in its own wave.
  const groups = new Map([
    [100, storyGroup(100, [{ id: 1001, dependsOn: [], focusAreas: ['api'] }])],
    [200, storyGroup(200, [{ id: 2001, dependsOn: [], focusAreas: ['web'] }])],
    [
      300,
      storyGroup(300, [
        { id: 3001, dependsOn: [], scope: 'root', focusAreas: [] },
      ]),
    ],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 0);
  // 300 depends on 100 and 200 via global overlap → wave 1
  assert.strictEqual(waves.get(300), 1);
});

test('computeStoryWaves: existing dependency edge prevents redundant overlap edge', () => {
  // Story 200 already depends on 100 via cross-task dependency. The overlap
  // edge would also point 100 → 200, so should be a no-op.
  const groups = new Map([
    [
      100,
      storyGroup(100, [
        { id: 1001, dependsOn: [], focusAreas: ['apps/api/media'] },
      ]),
    ],
    [
      200,
      storyGroup(200, [
        { id: 2001, dependsOn: [1001], focusAreas: ['apps/api/media'] },
      ]),
    ],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 1);
});

test('computeStoryWaves: five-way parallel contention resolves to linear chain', () => {
  // Reproduces the 2026-04-14 incident: five stories planned in parallel all
  // writing to the same focus area. Expected: exactly one per wave, in
  // ascending id order.
  const groups = new Map();
  for (const id of [302, 304, 307, 321, 347]) {
    groups.set(
      id,
      storyGroup(id, [
        {
          id: id * 10 + 1,
          dependsOn: [],
          focusAreas: ['apps/api/src/routes/v1/media'],
        },
      ]),
    );
  }

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(302), 0);
  assert.strictEqual(waves.get(304), 1);
  assert.strictEqual(waves.get(307), 2);
  assert.strictEqual(waves.get(321), 3);
  assert.strictEqual(waves.get(347), 4);
});

test('rollUpStoryFocus: unions task focus areas and detects global scope', () => {
  const groups = new Map([
    [
      100,
      storyGroup(100, [
        { id: 1, focusAreas: ['a', 'b'] },
        { id: 2, focusAreas: ['b', 'c'] },
      ]),
    ],
    [200, storyGroup(200, [{ id: 3, scope: 'root', focusAreas: ['x'] }])],
    [300, storyGroup(300, [{ id: 4, focusAreas: ['*'] }])],
  ]);

  const rolled = __test.rollUpStoryFocus(groups);
  assert.deepEqual([...rolled.get(100).areas].sort(), ['a', 'b', 'c']);
  assert.strictEqual(rolled.get(100).global, false);
  assert.strictEqual(rolled.get(200).global, true);
  assert.strictEqual(rolled.get(300).global, true);
});

// ---------------------------------------------------------------------------
// isFocusOverlapEdgeEligible (predicate, exported)
// ---------------------------------------------------------------------------

function focus(areas = [], global = false) {
  return { areas: new Set(areas), global };
}
function reach(pairs = []) {
  const m = new Map();
  for (const [from, to] of pairs) {
    if (!m.has(from)) m.set(from, new Set());
    m.get(from).add(to);
  }
  return m;
}

test('isFocusOverlapEdgeEligible: missing focus bag on either side → false', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: undefined,
      focusB: focus(['x']),
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x']),
      focusB: undefined,
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
});

test('isFocusOverlapEdgeEligible: both empty non-global → false', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus([]),
      focusB: focus([]),
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
});

test('isFocusOverlapEdgeEligible: one side empty non-global, other usable → false', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x']),
      focusB: focus([]),
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
});

test('isFocusOverlapEdgeEligible: disjoint areas → false', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x']),
      focusB: focus(['y']),
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
});

test('isFocusOverlapEdgeEligible: shared area → true', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x', 'y']),
      focusB: focus(['y']),
      reachable,
      a: 1,
      b: 2,
    }),
    true,
  );
});

test('isFocusOverlapEdgeEligible: A is global → true even with no shared areas', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus([], true),
      focusB: focus(['y']),
      reachable,
      a: 1,
      b: 2,
    }),
    true,
  );
});

test('isFocusOverlapEdgeEligible: B is global → true', () => {
  const reachable = reach();
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x']),
      focusB: focus([], true),
      reachable,
      a: 1,
      b: 2,
    }),
    true,
  );
});

test('isFocusOverlapEdgeEligible: a→b already reachable → false', () => {
  const reachable = reach([[1, 2]]);
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x']),
      focusB: focus(['x']),
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
});

test('isFocusOverlapEdgeEligible: b→a already reachable → false', () => {
  const reachable = reach([[2, 1]]);
  assert.equal(
    isFocusOverlapEdgeEligible({
      focusA: focus(['x']),
      focusB: focus(['x']),
      reachable,
      a: 1,
      b: 2,
    }),
    false,
  );
});
