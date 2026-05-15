/**
 * Tests for the manifest-render-waves module — direct exercise of
 * `renderNestedWaveSections` plus branch coverage of the private
 * `validateWaveSection` predicate (exposed via `__testables`).
 *
 * The existing `tests/lib/manifest-formatter.test.js` continues to
 * exercise the renderer through the formatter's re-export so the
 * round-trip layout is locked at the façade. This file targets the new
 * module directly (Story #1849 Task #1870).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testables,
  renderNestedWaveSections,
} from '../../../.agents/scripts/lib/presentation/manifest-render-waves.js';

const { validateWaveSection } = __testables;

// ---------------------------------------------------------------------------
// validateWaveSection — predicate branch coverage
// ---------------------------------------------------------------------------

test('validateWaveSection: storyManifest level accepts only arrays', () => {
  assert.equal(validateWaveSection('storyManifest', []), true);
  assert.equal(validateWaveSection('storyManifest', [{}]), true);
  assert.equal(validateWaveSection('storyManifest', null), false);
  assert.equal(validateWaveSection('storyManifest', undefined), false);
  assert.equal(validateWaveSection('storyManifest', {}), false);
  assert.equal(validateWaveSection('storyManifest', 'x'), false);
});

test('validateWaveSection: tasks level accepts only arrays', () => {
  assert.equal(validateWaveSection('tasks', []), true);
  assert.equal(validateWaveSection('tasks', [{ taskId: 1 }]), true);
  assert.equal(validateWaveSection('tasks', null), false);
  assert.equal(validateWaveSection('tasks', undefined), false);
  assert.equal(validateWaveSection('tasks', { taskId: 1 }), false);
});

test('validateWaveSection: story level accepts only non-null objects', () => {
  assert.equal(validateWaveSection('story', { storyId: 1, tasks: [] }), true);
  assert.equal(validateWaveSection('story', {}), true);
  assert.equal(validateWaveSection('story', null), false);
  assert.equal(validateWaveSection('story', undefined), false);
  assert.equal(validateWaveSection('story', 42), false);
});

test('validateWaveSection: unknown level falls through to false', () => {
  assert.equal(validateWaveSection('unknown', []), false);
  assert.equal(validateWaveSection('', {}), false);
});

// ---------------------------------------------------------------------------
// renderNestedWaveSections — entry-point behaviour
// ---------------------------------------------------------------------------

test('renderNestedWaveSections: returns empty string for null / empty / non-array input', () => {
  assert.equal(renderNestedWaveSections(null), '');
  assert.equal(renderNestedWaveSections(undefined), '');
  assert.equal(renderNestedWaveSections([]), '');
  // Non-array input is rejected by the predicate.
  assert.equal(renderNestedWaveSections('not-an-array'), '');
  assert.equal(renderNestedWaveSections({}), '');
});

test('renderNestedWaveSections: skips non-object entries inside the manifest', () => {
  const stories = [
    null,
    'invalid',
    {
      storyId: 101,
      storyTitle: 'Alpha',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## 🚀 Wave 0'));
  assert.ok(md.includes('### ⬜ #101 — Alpha · 0/1 tasks'));
  assert.ok(md.includes('- [ ] #200 — t1'));
});

test('renderNestedWaveSections: renders a single Ready wave with no parallel tail when story count is 1', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'Solo',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## 🚀 Wave 0'));
  assert.ok(!md.includes('run in parallel'));
});

test('renderNestedWaveSections: Ready wave with multiple stories emits the parallel-fan-out tail', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::ready' }],
    },
    {
      storyId: 102,
      storyTitle: 'B',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 201, taskSlug: 't2', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('· 2 run in parallel'));
});

test('renderNestedWaveSections: Blocked wave emits the gating tail naming the latest prior wave', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::ready' }],
    },
    {
      storyId: 102,
      storyTitle: 'B',
      type: 'story',
      earliestWave: 1,
      tasks: [{ taskId: 201, taskSlug: 't2', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('· gated on Wave 0'));
});

test('renderNestedWaveSections: empty story.tasks renders _(no tasks)_ marker', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'Empty',
      type: 'story',
      earliestWave: 0,
      tasks: [],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('_(no tasks)_'));
});

test('renderNestedWaveSections: Feature Containers section emits when type=feature entries exist', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::done' }],
    },
    {
      storyId: 300,
      storySlug: 'container',
      type: 'feature',
      earliestWave: -1,
      tasks: [{ taskId: 400, status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## Feature Containers'));
  assert.ok(md.includes('| #300 | container | 1 |'));
});

test('renderNestedWaveSections: Story title falls back to storySlug when storyTitle missing', () => {
  const stories = [
    {
      storyId: 101,
      storySlug: 'slug-only',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('### ⬜ #101 — slug-only'));
});

test('renderNestedWaveSections: task.title falls back when taskSlug missing', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      tasks: [{ taskId: 200, title: 'Long Title', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('- [ ] #200 — Long Title'));
});

test('renderNestedWaveSections: Ungrouped bucket (wave -1) renders as ungrouped heading', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: -1,
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('Ungrouped'));
});
