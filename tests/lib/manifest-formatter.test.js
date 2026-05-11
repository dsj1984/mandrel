import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeProgress,
  formatManifestMarkdown,
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
  renderManifestMarkdown,
  renderProgressBar,
  renderStoryTable,
  renderWaveSections,
  slugifyHeading,
  waveHeadingText,
} from '../../.agents/scripts/lib/presentation/manifest-formatter.js';

function epicManifest(overrides = {}) {
  return {
    epicId: 42,
    epicTitle: 'Demo Epic',
    dryRun: false,
    generatedAt: '2026-04-20T00:00:00.000Z',
    summary: {
      totalTasks: 4,
      doneTasks: 1,
      progressPercent: 25,
      dispatched: 2,
      totalWaves: 2,
    },
    storyManifest: [
      {
        storyId: 101,
        storySlug: 'alpha',
        storyTitle: 'Alpha Story',
        type: 'story',
        earliestWave: 0,
        branchName: 'story-101',
        tasks: [
          { taskId: 201, taskSlug: 't-a1', status: 'agent::done' },
          { taskId: 202, taskSlug: 't-a2', status: 'agent::ready' },
        ],
      },
      {
        storyId: 102,
        storySlug: 'beta',
        storyTitle: 'Beta Story',
        type: 'story',
        earliestWave: 1,
        branchName: 'story-102',
        tasks: [
          {
            taskId: 203,
            taskSlug: 't-b1',
            status: 'agent::ready',
            dependencies: [201],
          },
          { taskId: 204, taskSlug: 't-b2', status: 'agent::ready' },
        ],
      },
    ],
    ...overrides,
  };
}

test('formatter: renders epic header, progress, wave table, details', () => {
  const md = formatManifestMarkdown(epicManifest());
  assert.ok(md.includes('# 📋 Dispatch Manifest — Epic #42'));
  assert.ok(md.includes('> **Demo Epic**'));
  assert.ok(md.includes('## Wave Summary'));
  assert.ok(md.includes('Wave 0'));
  assert.ok(md.includes('Wave 1'));
  assert.ok(md.includes('## Story Details'));
  assert.ok(md.includes('Story #101: alpha'));
  assert.ok(md.includes('[x] **#201**'));
  assert.ok(md.includes('[ ] **#203** — t-b1 _(blocked by: #201)_'));
});

test('formatter: feature containers row when features present', () => {
  const manifest = epicManifest();
  manifest.storyManifest.push({
    storyId: 300,
    storySlug: 'container',
    type: 'feature',
    earliestWave: -1,
    branchName: 'feature-300',
    tasks: [{ taskId: 400, taskSlug: 'orphan', status: 'agent::ready' }],
  });
  const md = formatManifestMarkdown(manifest);
  assert.ok(md.includes('## Feature Containers'));
  assert.ok(md.includes('#300'));
});

test('formatter: renderManifestMarkdown alias matches formatManifestMarkdown', () => {
  const manifest = epicManifest();
  assert.equal(
    renderManifestMarkdown(manifest),
    formatManifestMarkdown(manifest),
  );
});

test('formatter: story execution manifest respects injected settings', () => {
  const md = formatStoryManifestMarkdown(
    {
      generatedAt: '2026-04-20T00:00:00.000Z',
      stories: [
        {
          storyId: 101,
          storyTitle: 'Alpha',
          epicBranch: 'epic/42',
          branchName: 'story-101',
          tasks: [
            {
              taskId: 201,
              title: 'Do the thing',
              status: 'agent::ready',
              dependencies: [],
            },
          ],
        },
      ],
    },
    {
      agentSettings: {
        paths: { scriptsRoot: 'custom/scripts' },
        commands: {
          validate: 'npm run check',
          test: 'npm run spec',
        },
      },
    },
  );
  assert.ok(md.includes('custom/scripts/story-init.js'));
  assert.ok(md.includes('Run `npm run check` and `npm run spec`'));
});

test('formatter: story execution manifest falls back to defaults when agentSettings absent', () => {
  const md = formatStoryManifestMarkdown({
    generatedAt: '2026-04-20T00:00:00.000Z',
    stories: [],
  });
  assert.ok(md.includes('.agents/scripts/story-init.js'));
  assert.ok(md.includes('npm run lint'));
  assert.ok(md.includes('npm test'));
});

test('formatter: printStoryDispatchTable writes to injected logger', () => {
  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  printStoryDispatchTable(
    [
      {
        storyId: 101,
        storySlug: 'alpha',
        type: 'story',
        earliestWave: 0,
        tasks: [{}, {}],
      },
      {
        storyId: 200,
        storySlug: 'container',
        type: 'feature',
        earliestWave: -1,
        tasks: [{}],
      },
    ],
    { logger },
  );
  const flat = lines.join('\n');
  assert.ok(flat.includes('📋 STORY DISPATCH TABLE'));
  assert.ok(flat.includes('#101'));
  assert.ok(flat.includes('📦 Feature Containers'));
});

test('formatter: printStoryDispatchTable no-ops on empty manifest', () => {
  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  printStoryDispatchTable([], { logger });
  assert.equal(lines.length, 0);
});

// ---------------------------------------------------------------------------
// Pure helper fixtures (Story #484)
// ---------------------------------------------------------------------------

test('computeProgress: aggregates task pct, story counts, wave count', () => {
  const result = computeProgress(epicManifest());
  assert.equal(result.taskPct, 25);
  assert.equal(result.doneTasks, 1);
  assert.equal(result.totalTasks, 4);
  assert.equal(result.totalStories, 2);
  assert.equal(result.doneStories, 0);
  assert.equal(result.storyWaveCount, 2);
});

test('computeProgress: counts a story as done only when every task is done', () => {
  const manifest = epicManifest();
  for (const task of manifest.storyManifest[0].tasks) {
    task.status = 'agent::done';
  }
  const result = computeProgress(manifest);
  assert.equal(result.doneStories, 1);
});

test('computeProgress: falls back to wave count of 1 when no waves are set', () => {
  const result = computeProgress({
    summary: { progressPercent: 0, doneTasks: 0, totalTasks: 0 },
    storyManifest: [
      {
        storyId: 1,
        type: 'story',
        earliestWave: -1,
        tasks: [],
      },
    ],
  });
  assert.equal(result.storyWaveCount, 1);
});

test('renderProgressBar: emits 20-cell bar by default with correct fill ratio', () => {
  const bar = renderProgressBar(50);
  assert.equal(bar.length, 20);
  assert.equal(bar, '██████████░░░░░░░░░░');
});

test('renderProgressBar: respects custom width and clamps out-of-range input', () => {
  assert.equal(renderProgressBar(100, { width: 5 }), '█████');
  assert.equal(renderProgressBar(0, { width: 5 }), '░░░░░');
  assert.equal(renderProgressBar(150, { width: 4 }), '████');
  assert.equal(renderProgressBar(-10, { width: 4 }), '░░░░');
});

test('renderWaveSections: renders one row per wave with status & mini bar', () => {
  const md = renderWaveSections(epicManifest().storyManifest);
  assert.ok(md.includes('## Wave Summary'));
  assert.ok(md.includes('| Wave | Status | Progress | Stories | Tasks |'));
  // The wave-cell is now a markdown link to the corresponding H2 anchor.
  assert.ok(md.includes('| [Wave 0](#'));
  assert.ok(md.includes('| [Wave 1](#'));
  assert.ok(md.includes('🚀 Ready'));
  assert.ok(md.includes('⏳ Blocked'));
});

test('renderWaveSections: each TOC row links to the slug of its wave heading', () => {
  const md = renderWaveSections(epicManifest().storyManifest);
  // Wave 0 (no prior waves) is Ready; Wave 1 depends on incomplete Wave 0 → Blocked.
  const expectedW0 = `#${slugifyHeading(waveHeadingText('Wave 0', '🚀 Ready'))}`;
  const expectedW1 = `#${slugifyHeading(waveHeadingText('Wave 1', '⏳ Blocked'))}`;
  assert.ok(
    md.includes(`| [Wave 0](${expectedW0}) |`),
    `expected Wave 0 link to ${expectedW0}`,
  );
  assert.ok(
    md.includes(`| [Wave 1](${expectedW1}) |`),
    `expected Wave 1 link to ${expectedW1}`,
  );
});

test('slugifyHeading: lowercases ASCII headings', () => {
  assert.equal(slugifyHeading('Wave 0 Ready'), 'wave-0-ready');
  assert.equal(slugifyHeading('UPPER CASE'), 'upper-case');
});

test('slugifyHeading: strips emojis and other punctuation', () => {
  // Emoji + em-dash both vanish; the surrounding whitespace then collapses.
  assert.equal(slugifyHeading('🚀 Wave 0 — Ready'), 'wave-0-ready');
  assert.equal(slugifyHeading('✅ Done!'), 'done');
  assert.equal(slugifyHeading('foo, bar; baz.'), 'foo-bar-baz');
});

test('slugifyHeading: collapses internal whitespace runs into single hyphens', () => {
  assert.equal(slugifyHeading('many   spaces  here'), 'many-spaces-here');
  assert.equal(slugifyHeading('tabs\tand\nnewlines'), 'tabs-and-newlines');
});

test('slugifyHeading: trims leading and trailing hyphens', () => {
  assert.equal(slugifyHeading('   leading   '), 'leading');
  assert.equal(slugifyHeading('--dash--wrapped--'), 'dash-wrapped');
});

test('slugifyHeading: handles null/undefined gracefully', () => {
  assert.equal(slugifyHeading(null), '');
  assert.equal(slugifyHeading(undefined), '');
  assert.equal(slugifyHeading(''), '');
});

test('renderWaveSections: returns empty string for empty input', () => {
  assert.equal(renderWaveSections([]), '');
  assert.equal(renderWaveSections(null), '');
});

test('renderWaveSections: marks a wave done when every task completed', () => {
  const stories = [
    {
      storyId: 1,
      type: 'story',
      earliestWave: 0,
      tasks: [
        { taskId: 10, status: 'agent::done' },
        { taskId: 11, status: 'agent::done' },
      ],
    },
  ];
  const md = renderWaveSections(stories);
  assert.ok(md.includes('✅ Done'));
});

test('renderStoryTable: groups stories by wave and flags parallel waves', () => {
  const manifest = epicManifest();
  manifest.storyManifest.push({
    storyId: 103,
    storySlug: 'gamma',
    type: 'story',
    earliestWave: 1,
    branchName: 'story-103',
    tasks: [{ taskId: 205, taskSlug: 't-c1', status: 'agent::ready' }],
  });
  const md = renderStoryTable(manifest.storyManifest);
  assert.ok(md.includes('## Execution Plan'));
  assert.ok(md.includes('### Wave 0'));
  assert.ok(md.includes('### Wave 1 — ✅ 2 stories can run in parallel'));
  assert.ok(md.includes('| ⬜ | #102 | beta |'));
});

test('renderStoryTable: appends a Feature Containers section when present', () => {
  const stories = [
    {
      storyId: 101,
      storySlug: 'alpha',
      type: 'story',
      earliestWave: 0,
      branchName: 'story-101',
      tasks: [{ taskId: 200, status: 'agent::done' }],
    },
    {
      storyId: 300,
      storySlug: 'container',
      type: 'feature',
      earliestWave: -1,
      branchName: 'feature-300',
      tasks: [{ taskId: 400, status: 'agent::ready' }],
    },
  ];
  const md = renderStoryTable(stories);
  assert.ok(md.includes('## Feature Containers'));
  assert.ok(md.includes('| #300 | container | 1 |'));
  // story with all tasks done renders ✅ checkbox
  assert.ok(md.includes('| ✅ | #101 | alpha |'));
});

test('renderStoryTable: returns empty string for empty input', () => {
  assert.equal(renderStoryTable([]), '');
  assert.equal(renderStoryTable(null), '');
});
