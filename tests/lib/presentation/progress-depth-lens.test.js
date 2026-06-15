/**
 * progress-depth-lens.test.js
 *
 * Story #4157 — the epic-run-progress rollup groups Stories by a
 * **render-time dependency depth** derived from each Story entry's
 * `dependsOn` edges via `assignLayers` (`lib/Graph.js`), not the persisted
 * `earliestWave` the planner stamped on the manifest. Scheduling no longer
 * persists waves onto the run checkpoint (Epic #4151 / Story #4155), so the
 * rollup re-derives depth from the dependency graph at the moment it renders.
 *
 * This suite pins three guarantees on the shared `deriveStoryDepths` lens and
 * the two operator-facing renderers that consume it:
 *
 *   1. Grouping depth is computed via `assignLayers` from `dependsOn`, NOT
 *      from a persisted wave field. The decisive cases stamp an `earliestWave`
 *      that *disagrees* with the dependency graph and assert the renderers
 *      group by the derived depth, proving the persisted field is ignored.
 *   2. The rollup renders correctly from the per-Story checkpoint shape with
 *      no `currentWave` / `plan` / `waves[]` fields present on the input.
 *   3. `assignLayers` semantics are honoured end-to-end (roots at depth 0,
 *      dependents one layer below their deepest in-set dependency, chains
 *      deepen, foreign edges are dropped).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignLayers } from '../../../.agents/scripts/lib/Graph.js';
import {
  countWaves,
  projectStoriesFromManifest,
  renderManifestFromManifest,
} from '../../../.agents/scripts/lib/presentation/dispatch-manifest-render.js';
import {
  deriveStoryDepths,
  renderNestedWaveSections,
} from '../../../.agents/scripts/lib/presentation/manifest-render-waves.js';
import { buildStoryAdjacency } from '../../../.agents/scripts/lib/story-adjacency.js';

/**
 * A per-Story checkpoint-shaped manifest: storyManifest entries carry only
 * the Story-tier fields the rollup needs (id, title, status, dependsOn).
 * Crucially there is **no** `currentWave`, `plan`, or `waves[]` field — the
 * shape Story #4155 left on the checkpoint.
 */
function checkpointManifest(stories, overrides = {}) {
  return {
    epicId: 4151,
    generatedAt: '2026-06-15T00:00:00.000Z',
    storyManifest: stories.map((s) => ({ type: 'story', ...s })),
    ...overrides,
  };
}

describe('deriveStoryDepths — render-time depth via assignLayers', () => {
  it('a Story with no dependency edges is depth 0', () => {
    const depths = deriveStoryDepths([
      { storyId: 1, type: 'story' },
      { storyId: 2, type: 'story' },
    ]);
    assert.equal(depths.get(1), 0);
    assert.equal(depths.get(2), 0);
  });

  it('a dependent sits one layer below its dependency', () => {
    const depths = deriveStoryDepths([
      { storyId: 1, type: 'story' },
      { storyId: 2, type: 'story', dependsOn: [1] },
    ]);
    assert.equal(depths.get(1), 0);
    assert.equal(depths.get(2), 1);
  });

  it('depth deepens along a dependency chain', () => {
    const depths = deriveStoryDepths([
      { storyId: 1, type: 'story' },
      { storyId: 2, type: 'story', dependsOn: [1] },
      { storyId: 3, type: 'story', dependsOn: [2] },
      { storyId: 4, type: 'story', dependsOn: [1, 3] },
    ]);
    assert.equal(depths.get(1), 0);
    assert.equal(depths.get(2), 1);
    assert.equal(depths.get(3), 2);
    // 4 depends on both 1 (depth 0) and 3 (depth 2) → max + 1 = 3.
    assert.equal(depths.get(4), 3);
  });

  it('is computed via assignLayers over buildStoryAdjacency (parity with the kernel)', () => {
    const stories = [
      { storyId: 10, type: 'story' },
      { storyId: 11, type: 'story', dependsOn: [10] },
      { storyId: 12, type: 'story', dependsOn: [11] },
    ];
    const lens = deriveStoryDepths(stories);
    const kernel = assignLayers(
      buildStoryAdjacency(
        stories.map((s) => ({ id: s.storyId, dependsOn: s.dependsOn ?? [] })),
      ),
    );
    for (const s of stories) {
      assert.equal(lens.get(s.storyId), kernel.get(s.storyId));
    }
  });

  it('ignores the persisted earliestWave field entirely', () => {
    // earliestWave is deliberately wrong relative to the dependency graph:
    // every Story claims wave 7 but only 2 depends on 1.
    const depths = deriveStoryDepths([
      { storyId: 1, type: 'story', earliestWave: 7 },
      { storyId: 2, type: 'story', earliestWave: 7, dependsOn: [1] },
    ]);
    assert.equal(depths.get(1), 0);
    assert.equal(depths.get(2), 1);
  });

  it('drops foreign edges so depth never deepens on an out-of-set reference', () => {
    // 2 declares a dependency on 999, which is not in the rendered set.
    // The closed-over DAG drops that edge → 2 stays at depth 0.
    const depths = deriveStoryDepths([
      { storyId: 1, type: 'story' },
      { storyId: 2, type: 'story', dependsOn: [999] },
    ]);
    assert.equal(depths.get(2), 0);
  });

  it('skips the __ungrouped__ sentinel and non-object entries', () => {
    const depths = deriveStoryDepths([
      null,
      'invalid',
      { storyId: '__ungrouped__', type: 'story' },
      { storyId: 5, type: 'story' },
    ]);
    assert.equal(depths.has('__ungrouped__'), false);
    assert.equal(depths.get(5), 0);
  });

  it('returns an empty map for non-array input', () => {
    assert.equal(deriveStoryDepths(null).size, 0);
    assert.equal(deriveStoryDepths(undefined).size, 0);
    assert.equal(deriveStoryDepths({}).size, 0);
  });
});

describe('renderNestedWaveSections — groups by derived depth, not earliestWave', () => {
  it('groups dependents into the wave their dependency depth dictates', () => {
    const md = renderNestedWaveSections([
      { storyId: 1, storyTitle: 'Root', type: 'story' },
      { storyId: 2, storyTitle: 'Leaf', type: 'story', dependsOn: [1] },
    ]);
    assert.ok(md.includes('## 🚀 Wave 0'));
    assert.ok(md.includes('### ⬜ #1 — Root'));
    assert.ok(md.includes('## ⏳ Wave 1'));
    assert.ok(md.includes('### ⬜ #2 — Leaf'));
  });

  it('honours the dependency graph even when earliestWave says otherwise', () => {
    // Both Stories are stamped earliestWave: 0 (a stale persisted plan), but
    // 2 depends on 1, so the render-time lens splits them into Wave 0 / Wave 1.
    const md = renderNestedWaveSections([
      { storyId: 1, storyTitle: 'Root', type: 'story', earliestWave: 0 },
      {
        storyId: 2,
        storyTitle: 'Leaf',
        type: 'story',
        earliestWave: 0,
        dependsOn: [1],
      },
    ]);
    assert.ok(md.includes('## 🚀 Wave 0'));
    assert.ok(md.includes('## ⏳ Wave 1'));
    assert.ok(md.includes('· gated on Wave 0'));
  });

  it('renders parallel roots (no edges) in a single Wave 0 with a fan-out tail', () => {
    const md = renderNestedWaveSections([
      { storyId: 1, storyTitle: 'A', type: 'story' },
      { storyId: 2, storyTitle: 'B', type: 'story' },
      { storyId: 3, storyTitle: 'C', type: 'story' },
    ]);
    assert.ok(md.includes('## 🚀 Wave 0'));
    assert.ok(md.includes('> 3 stories · 0/3 done · 3 run in parallel'));
    assert.ok(!md.includes('Wave 1'));
  });

  it('counts done/total per derived wave from Story status', () => {
    const md = renderNestedWaveSections([
      {
        storyId: 1,
        storyTitle: 'A',
        type: 'story',
        status: 'agent::done',
      },
      {
        storyId: 2,
        storyTitle: 'B',
        type: 'story',
        status: 'agent::executing',
        dependsOn: [1],
      },
    ]);
    assert.ok(md.includes('## ✅ Wave 0'));
    assert.ok(md.includes('> 1 story · 1/1 done'));
    assert.ok(md.includes('> 1 story · 0/1 done'));
  });
});

describe('rollup renders from the per-Story checkpoint shape (no wave fields)', () => {
  it('renderNestedWaveSections needs no currentWave / plan / waves[] field', () => {
    const manifest = checkpointManifest([
      { storyId: 1, storyTitle: 'Root' },
      { storyId: 2, storyTitle: 'Leaf', dependsOn: [1] },
    ]);
    // Guard the fixture: the checkpoint shape carries none of the retired
    // wave-plan fields.
    assert.equal('currentWave' in manifest, false);
    assert.equal('plan' in manifest, false);
    assert.equal('waves' in manifest, false);

    const md = renderNestedWaveSections(manifest.storyManifest);
    assert.ok(md.includes('## 🚀 Wave 0'));
    assert.ok(md.includes('## ⏳ Wave 1'));
  });

  it('projectStoriesFromManifest derives the wave column from the graph', () => {
    const manifest = checkpointManifest([
      { storyId: 1, storyTitle: 'Root' },
      { storyId: 2, storyTitle: 'Leaf', dependsOn: [1] },
      { storyId: 3, storyTitle: 'Tail', dependsOn: [2] },
    ]);
    const projected = projectStoriesFromManifest(manifest);
    assert.deepEqual(projected, [
      { storyId: 1, wave: 0, title: 'Root' },
      { storyId: 2, wave: 1, title: 'Leaf' },
      { storyId: 3, wave: 2, title: 'Tail' },
    ]);
  });

  it('projectStoriesFromManifest ignores a disagreeing persisted earliestWave', () => {
    const manifest = checkpointManifest([
      { storyId: 1, storyTitle: 'Root', earliestWave: 5 },
      { storyId: 2, storyTitle: 'Leaf', earliestWave: 5, dependsOn: [1] },
    ]);
    const projected = projectStoriesFromManifest(manifest);
    assert.deepEqual(projected, [
      { storyId: 1, wave: 0, title: 'Root' },
      { storyId: 2, wave: 1, title: 'Leaf' },
    ]);
  });

  it('renderManifestFromManifest reports the derived wave count', () => {
    const manifest = checkpointManifest([
      { storyId: 1, storyTitle: 'Root' },
      { storyId: 2, storyTitle: 'Leaf', dependsOn: [1] },
    ]);
    const body = renderManifestFromManifest(manifest);
    // Two derived depths (0 and 1) → two waves.
    assert.match(body, /- \*\*Waves:\*\* 2$/m);
    assert.match(body, /- \*\*Stories:\*\* 2$/m);
  });

  it('countWaves counts distinct derived depths', () => {
    const manifest = checkpointManifest([
      { storyId: 1, storyTitle: 'Root' },
      { storyId: 2, storyTitle: 'Leaf', dependsOn: [1] },
      { storyId: 3, storyTitle: 'Sibling' },
    ]);
    // Depths: {1:0, 2:1, 3:0} → distinct depths {0,1} → 2 waves.
    assert.equal(countWaves(projectStoriesFromManifest(manifest)), 2);
  });

  it('a flat checkpoint with no edges renders as a single Wave 0', () => {
    const manifest = checkpointManifest([
      { storyId: 1, storyTitle: 'A' },
      { storyId: 2, storyTitle: 'B' },
    ]);
    const md = renderNestedWaveSections(manifest.storyManifest);
    assert.ok(md.includes('## 🚀 Wave 0'));
    assert.ok(!md.includes('Wave 1'));
    // Wave count collapses to a single derived depth.
    assert.equal(countWaves(projectStoriesFromManifest(manifest)), 1);
  });
});
