/**
 * Tests for the manifest-render-waves module — direct exercise of
 * `renderNestedWaveSections` plus branch coverage of the private
 * `validateWaveSection` predicate (exposed via `__testables`).
 *
 * Story #3413 (3-tier cutover, final): the residual per-Task rendering
 * has been deleted. Each wave counts Stories (done/total), renders one
 * H3 per Story with no task suffix, and emits no `_(no tasks)_` marker
 * or `Child Tasks` feature-table column. A Story is "done" when its
 * top-level `status` is `agent::done`.
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

test('validateWaveSection: story level accepts only non-null objects', () => {
  assert.equal(validateWaveSection('story', { storyId: 1 }), true);
  assert.equal(validateWaveSection('story', {}), true);
  assert.equal(validateWaveSection('story', null), false);
  assert.equal(validateWaveSection('story', undefined), false);
  assert.equal(validateWaveSection('story', 42), false);
});

test('validateWaveSection: removed tasks level falls through to false', () => {
  assert.equal(validateWaveSection('tasks', []), false);
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

test('renderNestedWaveSections: skips non-object entries and renders Story H3 with no task suffix', () => {
  const stories = [
    null,
    'invalid',
    {
      storyId: 101,
      storyTitle: 'Alpha',
      type: 'story',
      earliestWave: 0,
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## 🚀 Wave 0'));
  assert.ok(md.includes('### ⬜ #101 — Alpha'));
  // No residual Task projection.
  assert.ok(!md.includes('tasks'));
  assert.ok(!md.includes('_(no tasks)_'));
});

test('renderNestedWaveSections: wave blockquote counts done/total Stories', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      status: 'agent::done',
    },
    {
      storyId: 102,
      storyTitle: 'B',
      type: 'story',
      earliestWave: 0,
      status: 'agent::ready',
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('> 2 stories · 1/2 done'));
});

test('renderNestedWaveSections: renders a single Ready wave with no parallel tail when story count is 1', () => {
  const stories = [
    { storyId: 101, storyTitle: 'Solo', type: 'story', earliestWave: 0 },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## 🚀 Wave 0'));
  assert.ok(md.includes('> 1 story · 0/1 done'));
  assert.ok(!md.includes('run in parallel'));
});

test('renderNestedWaveSections: Ready wave with multiple stories emits the parallel-fan-out tail', () => {
  const stories = [
    { storyId: 101, storyTitle: 'A', type: 'story', earliestWave: 0 },
    { storyId: 102, storyTitle: 'B', type: 'story', earliestWave: 0 },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('· 2 run in parallel'));
});

test('renderNestedWaveSections: Blocked wave emits the gating tail naming the latest prior wave', () => {
  const stories = [
    { storyId: 101, storyTitle: 'A', type: 'story', earliestWave: 0 },
    { storyId: 102, storyTitle: 'B', type: 'story', earliestWave: 1 },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('· gated on Wave 0'));
});

test('renderNestedWaveSections: Feature Containers section emits a Story-only column set', () => {
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      status: 'agent::done',
    },
    { storyId: 300, storySlug: 'container', type: 'feature', earliestWave: -1 },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## Feature Containers'));
  assert.ok(md.includes('| Feature | Title |'));
  assert.ok(md.includes('| #300 | container |'));
  assert.ok(!md.includes('Child Tasks'));
});

test('renderNestedWaveSections: Story title falls back to storySlug when storyTitle missing', () => {
  const stories = [
    {
      storyId: 101,
      storySlug: 'slug-only',
      type: 'story',
      earliestWave: 0,
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('### ⬜ #101 — slug-only'));
});

test('renderNestedWaveSections: Stories never emit per-Task checkbox rows (3-tier)', () => {
  // Under the 3-tier hierarchy Stories are leaves; the renderer no
  // longer projects child Task tickets even when a legacy caller still
  // hands in a populated `tasks` array.
  const stories = [
    {
      storyId: 101,
      storyTitle: 'A',
      type: 'story',
      earliestWave: 0,
      tasks: [{ title: 'Long Title', status: 'agent::ready' }],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(!md.includes('- [ ]'));
  assert.ok(!md.includes('- [x]'));
  assert.ok(!md.includes('_(no tasks)_'));
});

test('renderNestedWaveSections: Ungrouped bucket (wave -1) renders as ungrouped heading', () => {
  const stories = [
    { storyId: 101, storyTitle: 'A', type: 'story', earliestWave: -1 },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('Ungrouped'));
});
