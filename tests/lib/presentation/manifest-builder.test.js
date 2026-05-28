/**
 * Tests for the manifest-builder module — direct exercise of
 * `buildManifestFromSpec` plus branch coverage of the private
 * `validateSpecShape` predicate (exposed via `__testables`).
 *
 * Story #3195 (3-tier cutover): the per-Story task-counter projection
 * (`storyTotalTasks` / `storyDoneTasks`) was dropped. Story status is
 * now resolved directly from the Story-level `agent::*` label, and the
 * manifest summary counts `totalStories` / `doneStories`. The
 * `storyEntry.tasks[]` array is preserved as an empty array so
 * downstream call-sites that still iterate `tasks` (being migrated
 * under Feature #3181) read empty rather than `undefined`.
 *
 * The sibling test file in `tests/lib/manifest-formatter.test.js`
 * continues to exercise the renderer-facing re-export path. This file
 * targets the new module directly so the projection contract is locked
 * in one place independent of the formatter façade (Story #1849 Task
 * #1869).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testables,
  buildManifestFromSpec,
} from '../../../.agents/scripts/lib/presentation/manifest-builder.js';

const { validateSpecShape } = __testables;

// ---------------------------------------------------------------------------
// validateSpecShape — per-level guard predicate branch coverage
// ---------------------------------------------------------------------------

test('validateSpecShape: features level accepts only arrays', () => {
  assert.equal(validateSpecShape('features', []), true);
  assert.equal(validateSpecShape('features', [{}]), true);
  assert.equal(validateSpecShape('features', null), false);
  assert.equal(validateSpecShape('features', undefined), false);
  assert.equal(validateSpecShape('features', {}), false);
  assert.equal(validateSpecShape('features', 'features'), false);
});

test('validateSpecShape: stories level accepts only arrays', () => {
  assert.equal(validateSpecShape('stories', []), true);
  assert.equal(validateSpecShape('stories', [{}]), true);
  assert.equal(validateSpecShape('stories', null), false);
  assert.equal(validateSpecShape('stories', undefined), false);
  assert.equal(validateSpecShape('stories', {}), false);
});

test('validateSpecShape: tasks level accepts only arrays', () => {
  assert.equal(validateSpecShape('tasks', []), true);
  assert.equal(validateSpecShape('tasks', [{}]), true);
  assert.equal(validateSpecShape('tasks', null), false);
  assert.equal(validateSpecShape('tasks', undefined), false);
  assert.equal(validateSpecShape('tasks', {}), false);
});

test('validateSpecShape: story level accepts only non-null objects', () => {
  assert.equal(validateSpecShape('story', { slug: 'x' }), true);
  assert.equal(validateSpecShape('story', {}), true);
  assert.equal(validateSpecShape('story', null), false);
  assert.equal(validateSpecShape('story', undefined), false);
  assert.equal(validateSpecShape('story', 'story'), false);
  assert.equal(validateSpecShape('story', 42), false);
});

test('validateSpecShape: task level accepts only non-null objects', () => {
  assert.equal(validateSpecShape('task', { slug: 'x' }), true);
  assert.equal(validateSpecShape('task', {}), true);
  assert.equal(validateSpecShape('task', null), false);
  assert.equal(validateSpecShape('task', undefined), false);
  assert.equal(validateSpecShape('task', 7), false);
});

test('validateSpecShape: unknown level falls through to false', () => {
  assert.equal(validateSpecShape('unknown-level', { ok: true }), false);
  assert.equal(validateSpecShape('', []), false);
});

// ---------------------------------------------------------------------------
// buildManifestFromSpec — projection contract (3-tier shape)
// ---------------------------------------------------------------------------

function specFixture(overrides = {}) {
  return {
    epic: { id: 99, title: 'Test Epic' },
    features: [
      {
        slug: 'feat-a',
        title: 'Feature A',
        stories: [
          { slug: 'story-a1', title: 'Story A1', wave: 0 },
          { slug: 'story-a2', title: 'Story A2', wave: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

function stateFixture(mapping) {
  return { mapping };
}

test('buildManifestFromSpec: projects spec → manifest with epic and stories', () => {
  const mf = buildManifestFromSpec(specFixture(), {
    generatedAt: '2026-05-15T00:00:00.000Z',
  });
  assert.equal(mf.epicId, 99);
  assert.equal(mf.epicTitle, 'Test Epic');
  assert.equal(mf.summary.totalStories, 2);
  assert.equal(mf.summary.doneStories, 0);
  assert.equal(mf.summary.totalWaves, 2);
  assert.equal(mf.storyManifest.length, 2);
  assert.equal(mf.storyManifest[0].storySlug, 'story-a1');
  // 3-tier: `tasks` is preserved as an empty array so legacy iterators
  // don't break while Feature #3181 migrates them off.
  assert.deepEqual(mf.storyManifest[0].tasks, []);
});

test('buildManifestFromSpec: resolves slugs via state.mapping issueNumber', () => {
  const state = stateFixture({
    'story-a1': { issueNumber: 5001, lastObservedAgentState: 'agent::done' },
    'story-a2': {
      issueNumber: 5002,
      lastObservedAgentState: 'agent::executing',
    },
  });
  const mf = buildManifestFromSpec(specFixture(), { state });
  assert.equal(mf.storyManifest[0].storyId, 5001);
  assert.equal(mf.storyManifest[0].branchName, 'story-5001');
  assert.equal(mf.storyManifest[0].status, 'agent::done');
  assert.equal(mf.storyManifest[1].storyId, 5002);
  assert.equal(mf.storyManifest[1].status, 'agent::executing');
  assert.equal(mf.summary.doneStories, 1);
});

test('buildManifestFromSpec: falls back to slug: sentinel when no mapping', () => {
  const mf = buildManifestFromSpec(specFixture());
  assert.equal(mf.storyManifest[0].storyId, 'slug:story-a1');
  assert.equal(mf.storyManifest[0].branchName, 'story-story-a1');
});

test('buildManifestFromSpec: defaults Story status to agent::ready when un-mapped', () => {
  const mf = buildManifestFromSpec(specFixture());
  assert.equal(mf.storyManifest[0].status, 'agent::ready');
});

test('buildManifestFromSpec: ignores non-array features (validateSpecShape guard)', () => {
  const spec = { epic: { id: 1, title: 'x' }, features: 'not-an-array' };
  const mf = buildManifestFromSpec(spec);
  assert.deepEqual(mf.storyManifest, []);
  assert.equal(mf.summary.totalStories, 0);
  assert.equal(mf.summary.doneStories, 0);
});

test('buildManifestFromSpec: ignores non-array stories inside a feature', () => {
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [{ slug: 'f', stories: null }],
  };
  const mf = buildManifestFromSpec(spec);
  assert.deepEqual(mf.storyManifest, []);
});

test('buildManifestFromSpec: skips non-object stories', () => {
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [
      {
        slug: 'f',
        stories: [null, 'not-an-object', { slug: 's' }],
      },
    ],
  };
  const mf = buildManifestFromSpec(spec);
  assert.equal(mf.storyManifest.length, 1);
  assert.equal(mf.storyManifest[0].storySlug, 's');
});

test('buildManifestFromSpec: stories without a wave land in earliestWave=-1', () => {
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [
      {
        slug: 'f',
        stories: [{ slug: 's' }],
      },
    ],
  };
  const mf = buildManifestFromSpec(spec);
  assert.equal(mf.storyManifest[0].earliestWave, -1);
  assert.equal(mf.summary.totalWaves, 0);
});

test('buildManifestFromSpec: missing epic block yields null epicId and empty title', () => {
  const mf = buildManifestFromSpec({ features: [] });
  assert.equal(mf.epicId, null);
  assert.equal(mf.epicTitle, '');
});

test('buildManifestFromSpec: honours opts.executor / dryRun / generatedAt / agentTelemetry', () => {
  const tel = { totalFriction: 0, recentFriction: [] };
  const mf = buildManifestFromSpec(specFixture(), {
    executor: 'manual',
    dryRun: true,
    generatedAt: '2026-05-15T01:23:45.000Z',
    agentTelemetry: tel,
  });
  assert.equal(mf.executor, 'manual');
  assert.equal(mf.dryRun, true);
  assert.equal(mf.generatedAt, '2026-05-15T01:23:45.000Z');
  assert.equal(mf.agentTelemetry, tel);
});

test('buildManifestFromSpec: progressPercent rounds doneStories/totalStories to nearest integer', () => {
  // 3 stories, 2 done = 67%
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [
      {
        slug: 'f',
        stories: [
          { slug: 's1', wave: 0 },
          { slug: 's2', wave: 0 },
          { slug: 's3', wave: 0 },
        ],
      },
    ],
  };
  const state = stateFixture({
    s1: { lastObservedAgentState: 'agent::done' },
    s2: { lastObservedAgentState: 'agent::done' },
    s3: { lastObservedAgentState: 'agent::executing' },
  });
  const mf = buildManifestFromSpec(spec, { state });
  assert.equal(mf.summary.totalStories, 3);
  assert.equal(mf.summary.doneStories, 2);
  assert.equal(mf.summary.progressPercent, 67);
});

test('buildManifestFromSpec: state with non-object mapping is treated as empty', () => {
  const spec = specFixture();
  const mf = buildManifestFromSpec(spec, { state: { mapping: null } });
  assert.equal(mf.storyManifest[0].storyId, 'slug:story-a1');
  assert.equal(mf.storyManifest[0].status, 'agent::ready');
});
