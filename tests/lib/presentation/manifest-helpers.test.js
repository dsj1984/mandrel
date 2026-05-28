/**
 * tests/lib/presentation/manifest-helpers.test.js
 *
 * Contract tests for the Story-only `manifest-helpers.js` surface
 * (Story #3194, Epic #3163). The helpers no longer walk `story.tasks[]`
 * or `task.taskId` — each Story carries its lifecycle on a top-level
 * `status` field. These tests exercise the new shape directly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_LABELS } from '../../../.agents/scripts/lib/label-constants.js';
import {
  computeProgress,
  deriveStorySymbol,
  deriveWaveStatus,
  renderProgressBar,
  renderWaveSections,
  slugifyHeading,
  waveHeadingText,
} from '../../../.agents/scripts/lib/presentation/manifest-helpers.js';

// ---------------------------------------------------------------------------
// deriveStorySymbol — reads story.status only
// ---------------------------------------------------------------------------

test('deriveStorySymbol: 🚧 for agent::blocked', () => {
  assert.equal(deriveStorySymbol({ status: AGENT_LABELS.BLOCKED }), '🚧');
});

test('deriveStorySymbol: ✅ for agent::done', () => {
  assert.equal(deriveStorySymbol({ status: AGENT_LABELS.DONE }), '✅');
});

test('deriveStorySymbol: 🔄 for agent::executing', () => {
  assert.equal(deriveStorySymbol({ status: AGENT_LABELS.EXECUTING }), '🔄');
});

test('deriveStorySymbol: ⬜ for agent::ready / unset / unknown', () => {
  assert.equal(deriveStorySymbol({ status: AGENT_LABELS.READY }), '⬜');
  assert.equal(deriveStorySymbol({}), '⬜');
  assert.equal(deriveStorySymbol(null), '⬜');
  assert.equal(deriveStorySymbol({ status: 'agent::mystery' }), '⬜');
});

// ---------------------------------------------------------------------------
// computeProgress — derives doneStories from story.status
// ---------------------------------------------------------------------------

function manifestFixture(stories) {
  return {
    summary: { progressPercent: 25, doneTasks: 1, totalTasks: 4 },
    storyManifest: stories,
  };
}

test('computeProgress: doneStories counts stories whose status is agent::done', () => {
  const manifest = manifestFixture([
    { storyId: 101, type: 'story', earliestWave: 0, status: AGENT_LABELS.DONE },
    {
      storyId: 102,
      type: 'story',
      earliestWave: 1,
      status: AGENT_LABELS.READY,
    },
  ]);
  const result = computeProgress(manifest);
  assert.equal(result.doneStories, 1);
  assert.equal(result.totalStories, 2);
  assert.equal(result.storyWaveCount, 2);
  // Task-tier passthroughs come from summary directly.
  assert.equal(result.taskPct, 25);
  assert.equal(result.doneTasks, 1);
  assert.equal(result.totalTasks, 4);
});

test('computeProgress: stories without status are not counted as done', () => {
  const manifest = manifestFixture([
    { storyId: 101, type: 'story', earliestWave: 0 },
    { storyId: 102, type: 'story', earliestWave: 0 },
  ]);
  const result = computeProgress(manifest);
  assert.equal(result.doneStories, 0);
  assert.equal(result.totalStories, 2);
});

test('computeProgress: __ungrouped__ sentinel is excluded from totals', () => {
  const manifest = manifestFixture([
    {
      storyId: '__ungrouped__',
      type: 'story',
      earliestWave: -1,
      status: AGENT_LABELS.DONE,
    },
    { storyId: 101, type: 'story', earliestWave: 0, status: AGENT_LABELS.DONE },
  ]);
  const result = computeProgress(manifest);
  assert.equal(result.totalStories, 1);
  assert.equal(result.doneStories, 1);
});

test('computeProgress: storyWaveCount falls back to 1 when no real waves are set', () => {
  const result = computeProgress(
    manifestFixture([
      { storyId: 1, type: 'story', earliestWave: -1, status: 'agent::ready' },
    ]),
  );
  assert.equal(result.storyWaveCount, 1);
});

// ---------------------------------------------------------------------------
// renderWaveSections — Story-tier counts in TOC rows
// ---------------------------------------------------------------------------

test('renderWaveSections: TOC header carries Stories column only', () => {
  const md = renderWaveSections([
    { storyId: 1, type: 'story', earliestWave: 0, status: AGENT_LABELS.DONE },
    { storyId: 2, type: 'story', earliestWave: 1, status: AGENT_LABELS.READY },
  ]);
  assert.ok(md.includes('| Wave | Status | Stories |'));
  assert.ok(!md.includes('| Wave | Status | Stories | Tasks |'));
});

test('renderWaveSections: cell shows doneStories/totalStories per wave', () => {
  const md = renderWaveSections([
    { storyId: 1, type: 'story', earliestWave: 0, status: AGENT_LABELS.DONE },
    { storyId: 2, type: 'story', earliestWave: 0, status: AGENT_LABELS.READY },
  ]);
  assert.ok(md.includes('1/2'));
});

test('renderWaveSections: wave is Done when every Story is agent::done', () => {
  const md = renderWaveSections([
    { storyId: 1, type: 'story', earliestWave: 0, status: AGENT_LABELS.DONE },
    { storyId: 2, type: 'story', earliestWave: 0, status: AGENT_LABELS.DONE },
  ]);
  assert.ok(md.includes('✅ Done'));
});

test('renderWaveSections: wave is Blocked when prior wave has un-done Stories', () => {
  const md = renderWaveSections([
    { storyId: 1, type: 'story', earliestWave: 0, status: AGENT_LABELS.READY },
    { storyId: 2, type: 'story', earliestWave: 1, status: AGENT_LABELS.READY },
  ]);
  assert.ok(md.includes('⏳ Blocked'));
});

test('renderWaveSections: empty / null input → empty string', () => {
  assert.equal(renderWaveSections([]), '');
  assert.equal(renderWaveSections(null), '');
});

// ---------------------------------------------------------------------------
// deriveWaveStatus — unit-agnostic { total, done } contract
// ---------------------------------------------------------------------------

test('deriveWaveStatus: ✅ Done when done === total > 0', () => {
  const stats = new Map([[0, { total: 3, done: 3 }]]);
  assert.deepEqual(deriveWaveStatus(0, stats, [0]), {
    emoji: '✅',
    word: 'Done',
    label: '✅ Done',
  });
});

test('deriveWaveStatus: 🚀 Ready for wave 0 or when every prior wave is done', () => {
  const stats = new Map([
    [0, { total: 1, done: 1 }],
    [1, { total: 2, done: 0 }],
  ]);
  assert.equal(deriveWaveStatus(1, stats, [0, 1]).word, 'Ready');
});

test('deriveWaveStatus: ⏳ Blocked when any prior wave is incomplete', () => {
  const stats = new Map([
    [0, { total: 2, done: 0 }],
    [1, { total: 2, done: 0 }],
  ]);
  assert.equal(deriveWaveStatus(1, stats, [0, 1]).word, 'Blocked');
});

// ---------------------------------------------------------------------------
// slugifyHeading / waveHeadingText / renderProgressBar — unchanged surface
// ---------------------------------------------------------------------------

test('slugifyHeading: GitHub-flavoured slug algorithm', () => {
  assert.equal(slugifyHeading('🚀 Wave 0 — Ready'), 'wave-0-ready');
  assert.equal(slugifyHeading('UPPER CASE'), 'upper-case');
  assert.equal(slugifyHeading(null), '');
});

test('waveHeadingText: emoji + label', () => {
  assert.equal(waveHeadingText('Wave 0', '🚀'), '🚀 Wave 0');
});

test('renderProgressBar: clamps to [0,100] and respects width', () => {
  assert.equal(renderProgressBar(50).length, 20);
  assert.equal(renderProgressBar(100, { width: 5 }), '█████');
  assert.equal(renderProgressBar(-10, { width: 4 }), '░░░░');
});
