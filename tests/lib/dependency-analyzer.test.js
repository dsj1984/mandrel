import assert from 'node:assert/strict';
import test from 'node:test';
import { computeStoryWaves } from '../../.agents/scripts/lib/orchestration/dependency-analyzer.js';

// ---------------------------------------------------------------------------
// computeStoryWaves — story-level wave assignment from explicit `blocked by`
// declarations and cross-story task dependencies.
//
// Story #3906 removed the focus-overlap engine: a Story's `focusAreas` /
// `scope` no longer influence wave assignment (the engine added zero edges
// on every 3-tier plan because Stories carry no child tasks). Wave order is
// driven solely by explicit story-to-story deps and cross-story task deps.
// ---------------------------------------------------------------------------

function storyGroup(storyId, tasks = []) {
  return { storyId, storyTitle: `Story ${storyId}`, type: 'story', tasks };
}

test('computeStoryWaves: independent stories share wave 0', () => {
  const groups = new Map([
    [100, storyGroup(100)],
    [200, storyGroup(200)],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 0);
});

test('computeStoryWaves: focus areas no longer serialize stories (engine removed)', () => {
  // Two stories touching the same focus area used to be serialized; after
  // Story #3906 they stay parallel because focus-overlap no longer adds edges.
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
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 0);
});

test('computeStoryWaves: explicit blocked-by serializes the blocked story', () => {
  // Story 200 is `blocked by` Story 100 → 100 in wave 0, 200 in wave 1.
  const groups = new Map([
    [100, storyGroup(100)],
    [200, storyGroup(200)],
  ]);
  const explicitDeps = new Map([[200, [100]]]);

  const waves = computeStoryWaves(groups, explicitDeps);
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 1);
});

test('computeStoryWaves: ignores explicit deps on stories outside the group', () => {
  // A `blocked by #999` reference to a story not in this Epic is dropped.
  const groups = new Map([[100, storyGroup(100)]]);
  const explicitDeps = new Map([[100, [999]]]);

  const waves = computeStoryWaves(groups, explicitDeps);
  assert.strictEqual(waves.get(100), 0);
});

test('computeStoryWaves: cross-story task dependency serializes stories', () => {
  // Task 2001 in story 200 depends on task 1001 in story 100.
  const groups = new Map([
    [100, storyGroup(100, [{ id: 1001, dependsOn: [] }])],
    [200, storyGroup(200, [{ id: 2001, dependsOn: [1001] }])],
  ]);

  const waves = computeStoryWaves(groups, new Map());
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 1);
});

test('computeStoryWaves: explicit chain produces ascending waves', () => {
  const groups = new Map([
    [100, storyGroup(100)],
    [200, storyGroup(200)],
    [300, storyGroup(300)],
  ]);
  const explicitDeps = new Map([
    [200, [100]],
    [300, [200]],
  ]);

  const waves = computeStoryWaves(groups, explicitDeps);
  assert.strictEqual(waves.get(100), 0);
  assert.strictEqual(waves.get(200), 1);
  assert.strictEqual(waves.get(300), 2);
});

test('computeStoryWaves: throws on a dependency cycle', () => {
  const groups = new Map([
    [100, storyGroup(100)],
    [200, storyGroup(200)],
  ]);
  const explicitDeps = new Map([
    [100, [200]],
    [200, [100]],
  ]);

  assert.throws(
    () => computeStoryWaves(groups, explicitDeps),
    /dependency cycle detected/i,
  );
});
