/**
 * Tests for the manifest-builder module — direct exercise of
 * `buildManifestFromSpec` plus branch coverage of the private
 * `validateSpecShape` predicate (exposed via `__testables`).
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
// buildManifestFromSpec — projection contract
// ---------------------------------------------------------------------------

function specFixture(overrides = {}) {
  return {
    epic: { id: 99, title: 'Test Epic' },
    features: [
      {
        slug: 'feat-a',
        title: 'Feature A',
        stories: [
          {
            slug: 'story-a1',
            title: 'Story A1',
            wave: 0,
            tasks: [{ slug: 'task-a1-1' }, { slug: 'task-a1-2' }],
          },
          {
            slug: 'story-a2',
            title: 'Story A2',
            wave: 1,
            tasks: [{ slug: 'task-a2-1' }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function stateFixture(mapping) {
  return { mapping };
}

test('buildManifestFromSpec: projects spec → manifest with epic, stories, tasks', () => {
  const mf = buildManifestFromSpec(specFixture(), {
    generatedAt: '2026-05-15T00:00:00.000Z',
  });
  assert.equal(mf.epicId, 99);
  assert.equal(mf.epicTitle, 'Test Epic');
  assert.equal(mf.summary.totalTasks, 3);
  assert.equal(mf.summary.doneTasks, 0);
  assert.equal(mf.summary.totalWaves, 2);
  assert.equal(mf.storyManifest.length, 2);
  assert.equal(mf.storyManifest[0].storySlug, 'story-a1');
  assert.equal(mf.storyManifest[0].tasks.length, 2);
});

test('buildManifestFromSpec: resolves slugs via state.mapping issueNumber', () => {
  const state = stateFixture({
    'story-a1': { issueNumber: 5001, lastObservedAgentState: 'agent::done' },
    'task-a1-1': { issueNumber: 6001, lastObservedAgentState: 'agent::done' },
  });
  const mf = buildManifestFromSpec(specFixture(), { state });
  assert.equal(mf.storyManifest[0].storyId, 5001);
  assert.equal(mf.storyManifest[0].branchName, 'story-5001');
  assert.equal(mf.storyManifest[0].tasks[0].taskId, 6001);
  assert.equal(mf.summary.doneTasks, 1);
});

test('buildManifestFromSpec: falls back to slug: sentinel when no mapping', () => {
  const mf = buildManifestFromSpec(specFixture());
  assert.equal(mf.storyManifest[0].storyId, 'slug:story-a1');
  assert.equal(mf.storyManifest[0].branchName, 'story-story-a1');
  assert.equal(mf.storyManifest[0].tasks[0].taskId, 'slug:task-a1-1');
});

test('buildManifestFromSpec: defaults task status to agent::ready when un-mapped', () => {
  const mf = buildManifestFromSpec(specFixture());
  assert.equal(mf.storyManifest[0].tasks[0].status, 'agent::ready');
});

test('buildManifestFromSpec: ignores non-array features (validateSpecShape guard)', () => {
  const spec = { epic: { id: 1, title: 'x' }, features: 'not-an-array' };
  const mf = buildManifestFromSpec(spec);
  assert.deepEqual(mf.storyManifest, []);
  assert.equal(mf.summary.totalTasks, 0);
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
        stories: [null, 'not-an-object', { slug: 's', tasks: [] }],
      },
    ],
  };
  const mf = buildManifestFromSpec(spec);
  assert.equal(mf.storyManifest.length, 1);
  assert.equal(mf.storyManifest[0].storySlug, 's');
});

test('buildManifestFromSpec: ignores non-array story.tasks', () => {
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [
      {
        slug: 'f',
        stories: [{ slug: 's', tasks: 'broken' }],
      },
    ],
  };
  const mf = buildManifestFromSpec(spec);
  assert.equal(mf.storyManifest.length, 1);
  assert.deepEqual(mf.storyManifest[0].tasks, []);
});

test('buildManifestFromSpec: skips non-object tasks inside a story', () => {
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [
      {
        slug: 'f',
        stories: [{ slug: 's', tasks: [null, 'bad', { slug: 't1' }] }],
      },
    ],
  };
  const mf = buildManifestFromSpec(spec);
  assert.equal(mf.storyManifest[0].tasks.length, 1);
  assert.equal(mf.storyManifest[0].tasks[0].taskSlug, 't1');
});

test('buildManifestFromSpec: stories without a wave land in earliestWave=-1', () => {
  const spec = {
    epic: { id: 1, title: 'x' },
    features: [
      {
        slug: 'f',
        stories: [{ slug: 's', tasks: [{ slug: 't' }] }],
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

test('buildManifestFromSpec: progressPercent rounds done/total to nearest integer', () => {
  const state = stateFixture({
    'task-a1-1': { lastObservedAgentState: 'agent::done' },
    'task-a1-2': { lastObservedAgentState: 'agent::done' },
  });
  const mf = buildManifestFromSpec(specFixture(), { state });
  // 2/3 = 67% (rounded)
  assert.equal(mf.summary.progressPercent, 67);
});

test('buildManifestFromSpec: state with non-object mapping is treated as empty', () => {
  const spec = specFixture();
  const mf = buildManifestFromSpec(spec, { state: { mapping: null } });
  assert.equal(mf.storyManifest[0].storyId, 'slug:story-a1');
});
