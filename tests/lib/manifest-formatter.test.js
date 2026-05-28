import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeProgress,
  deriveWaveStatus,
  formatManifestMarkdown,
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
  renderManifestMarkdown,
  renderNestedWaveSections,
  renderProceduresAndLegendDetails,
  renderProgressBar,
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
      config: {
        project: {
          paths: { scriptsRoot: 'custom/scripts' },
          commands: {
            validate: 'npm run check',
            test: 'npm run spec',
          },
        },
      },
    },
  );
  assert.ok(md.includes('custom/scripts/story-init.js'));
  assert.ok(md.includes('Run `npm run check` and `npm run spec`'));
});

test('formatter: story execution manifest falls back to defaults when config absent', () => {
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

test('computeProgress: counts a story as done from its top-level status', () => {
  const manifest = epicManifest();
  manifest.storyManifest[0].status = 'agent::done';
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

test('renderWaveSections: renders one row per wave with Story-tier counts', () => {
  const md = renderWaveSections(epicManifest().storyManifest);
  assert.ok(md.includes('## Wave Summary'));
  assert.ok(md.includes('| Wave | Status | Stories |'));
  assert.ok(!md.includes('| Wave | Status | Progress |'));
  // The wave-cell is a markdown link to the corresponding H2 anchor.
  assert.ok(md.includes('| [Wave 0](#'));
  assert.ok(md.includes('| [Wave 1](#'));
  assert.ok(md.includes('🚀 Ready'));
  assert.ok(md.includes('⏳ Blocked'));
});

test('renderWaveSections: each TOC row links to the slug of its emoji-only wave heading', () => {
  const md = renderWaveSections(epicManifest().storyManifest);
  // The H2 emits `## <emoji> Wave N`, so the TOC anchor strips the emoji
  // and produces `wave-N`.
  const expectedW0 = `#${slugifyHeading(waveHeadingText('Wave 0', '🚀'))}`;
  const expectedW1 = `#${slugifyHeading(waveHeadingText('Wave 1', '⏳'))}`;
  assert.equal(expectedW0, '#wave-0');
  assert.equal(expectedW1, '#wave-1');
  assert.ok(
    md.includes(`| [Wave 0](${expectedW0}) |`),
    `expected Wave 0 link to ${expectedW0}`,
  );
  assert.ok(
    md.includes(`| [Wave 1](${expectedW1}) |`),
    `expected Wave 1 link to ${expectedW1}`,
  );
});

test('deriveWaveStatus: returns emoji + word + label for Ready / Blocked / Done', () => {
  const stats = new Map([
    [0, { total: 2, done: 2 }],
    [1, { total: 2, done: 0 }],
    [2, { total: 2, done: 0 }],
  ]);
  const sorted = [0, 1, 2];
  assert.deepEqual(deriveWaveStatus(0, stats, sorted), {
    emoji: '✅',
    word: 'Done',
    label: '✅ Done',
  });
  assert.deepEqual(deriveWaveStatus(1, stats, sorted), {
    emoji: '🚀',
    word: 'Ready',
    label: '🚀 Ready',
  });
  assert.deepEqual(deriveWaveStatus(2, stats, sorted), {
    emoji: '⏳',
    word: 'Blocked',
    label: '⏳ Blocked',
  });
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

test('renderWaveSections: marks a wave done when every Story completed', () => {
  const stories = [
    {
      storyId: 1,
      type: 'story',
      earliestWave: 0,
      status: 'agent::done',
    },
  ];
  const md = renderWaveSections(stories);
  assert.ok(md.includes('✅ Done'));
});

test('renderNestedWaveSections: returns empty string for empty input', () => {
  assert.equal(renderNestedWaveSections([]), '');
  assert.equal(renderNestedWaveSections(null), '');
});

test('renderNestedWaveSections: H2 anchors match the TOC link slugs', () => {
  const md =
    renderWaveSections(epicManifest().storyManifest) +
    '\n' +
    renderNestedWaveSections(epicManifest().storyManifest);
  // For each TOC link `[Wave N](#slug)`, an H2 with the slug-equivalent
  // text must exist in the same document.
  const linkRe = /\[(Wave \d+|Ungrouped)\]\(#([^)]+)\)/g;
  const matches = [...md.matchAll(linkRe)];
  assert.ok(matches.length > 0, 'expected at least one TOC link');
  for (const [, , anchor] of matches) {
    const headingRe = /^## (.+)$/gm;
    const slugs = [...md.matchAll(headingRe)].map((m) => slugifyHeading(m[1]));
    assert.ok(
      slugs.includes(anchor),
      `TOC anchor #${anchor} has no matching H2 (slugs: ${slugs.join(', ')})`,
    );
  }
});

// The legacy per-Task topo-sort / `*(after #N)*` callout tests were
// removed when Epic #3163 collapsed the per-Story Task rendering: under
// the 3-tier hierarchy Stories are leaves with no child Task tickets, so
// `renderNestedWaveSections` no longer projects a Task-level checkbox
// list and the `topoSortTasks` helper was deleted as dead code.

// ---------------------------------------------------------------------------
// Bottom <details> block (operating procedures + full symbol legend)
// ---------------------------------------------------------------------------

test('renderProceduresAndLegendDetails: emits exactly one <details>/</details> pair', () => {
  const md = renderProceduresAndLegendDetails(42);
  assert.equal(
    (md.match(/<details>/g) || []).length,
    1,
    'expected exactly one <details> opener',
  );
  assert.equal(
    (md.match(/<\/details>/g) || []).length,
    1,
    'expected exactly one </details> closer',
  );
  // Operating Procedures + symbol legend live inside.
  assert.match(md, /Operating Procedures/);
  assert.match(md, /Symbol legend/);
  // Epic id substituted into the deliver/close examples.
  assert.match(md, /\/epic-deliver 42/);
});
