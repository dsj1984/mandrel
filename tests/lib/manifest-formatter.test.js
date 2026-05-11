import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeProgress,
  computeStoryProgress,
  formatManifestMarkdown,
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
  renderManifestMarkdown,
  renderNestedWaveSections,
  renderProgressBar,
  renderWaveSections,
  slugifyHeading,
  topoSortTasks,
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

test('formatter: renders epic header, progress, wave TOC, and nested H2/H3 layout', () => {
  const md = formatManifestMarkdown(epicManifest());
  assert.ok(md.includes('# 📋 Dispatch Manifest — Epic #42'));
  assert.ok(md.includes('> **Demo Epic**'));
  // TOC table
  assert.ok(md.includes('## Wave Summary'));
  assert.ok(md.includes('| Wave | Status | Progress | Stories | Tasks |'));
  // Per-wave H2 sections (replace legacy Execution Plan / Story Details)
  assert.ok(md.includes('## 🚀 Ready Wave 0'));
  assert.ok(md.includes('## ⏳ Blocked Wave 1'));
  // Per-Story H3 carries symbol, #id, branch in backticks, 10-cell bar
  assert.ok(md.includes('### 🔄 #101 — '));
  assert.ok(md.includes('`story-101`'));
  // Tasks render as plain checkbox lines
  assert.ok(md.includes('- [x] #201 — t-a1'));
  assert.ok(md.includes('- [ ] #203 — t-b1'));
  // Legacy headings are gone
  assert.ok(!md.includes('## Execution Plan'));
  assert.ok(!md.includes('## Story Details'));
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

test('renderNestedWaveSections: emits one ## Wave H2 per wave with H3 stories and checkbox tasks', () => {
  const manifest = epicManifest();
  manifest.storyManifest.push({
    storyId: 103,
    storySlug: 'gamma',
    storyTitle: 'Gamma Story',
    type: 'story',
    earliestWave: 1,
    branchName: 'story-103',
    tasks: [{ taskId: 205, taskSlug: 't-c1', status: 'agent::ready' }],
  });
  const md = renderNestedWaveSections(manifest.storyManifest);
  // One H2 per wave; legacy headings gone
  assert.ok(!md.includes('## Execution Plan'));
  assert.ok(!md.includes('## Story Details'));
  const w0 = md.match(/^## 🚀 Ready Wave 0$/gm) || [];
  const w1 = md.match(/^## ⏳ Blocked Wave 1$/gm) || [];
  assert.equal(w0.length, 1, 'exactly one Wave 0 H2');
  assert.equal(w1.length, 1, 'exactly one Wave 1 H2');
  // Single-line wave summary with parallel hint when stories > 1
  assert.ok(md.includes('✅ 2 stories can run in parallel'));
  // Per-Story H3 carries symbol, #id, branch in backticks, 10-cell bar
  assert.ok(md.includes('### 🔄 #101 — Alpha Story · `story-101` ·'));
  assert.ok(md.match(/### 🔄 #101.*[█░]{10}/));
  // Tasks rendered as plain checkbox lines (no HTML, no bold)
  assert.ok(md.includes('- [x] #201 — t-a1'));
  assert.ok(md.includes('- [ ] #205 — t-c1'));
});

test('renderNestedWaveSections: appends a Feature Containers section when present', () => {
  const stories = [
    {
      storyId: 101,
      storySlug: 'alpha',
      storyTitle: 'Alpha Story',
      type: 'story',
      earliestWave: 0,
      branchName: 'story-101',
      tasks: [{ taskId: 200, taskSlug: 't1', status: 'agent::done' }],
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
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('## Feature Containers'));
  assert.ok(md.includes('| #300 | container | 1 |'));
  // story with all tasks done renders ✅ symbol on the H3
  assert.ok(md.includes('### ✅ #101 — Alpha Story'));
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

test('topoSortTasks: orders T1 → T2 → T3 root-first when T2 deps T1, T3 deps T2', () => {
  const tasks = [
    { taskId: 3, dependencies: [2] },
    { taskId: 1, dependencies: [] },
    { taskId: 2, dependencies: [1] },
  ];
  const sorted = topoSortTasks(tasks);
  assert.deepEqual(
    sorted.map((t) => t.taskId),
    [1, 2, 3],
  );
});

test('topoSortTasks: preserves declaration order when no edges exist', () => {
  const tasks = [
    { taskId: 7, dependencies: [] },
    { taskId: 4, dependencies: [] },
    { taskId: 9, dependencies: [] },
  ];
  assert.deepEqual(
    topoSortTasks(tasks).map((t) => t.taskId),
    [7, 4, 9],
  );
});

test('topoSortTasks: ignores cross-Story dependency ids', () => {
  // 99 is not in this Story → must not block 2.
  const tasks = [
    { taskId: 1, dependencies: [] },
    { taskId: 2, dependencies: [99] },
  ];
  assert.deepEqual(
    topoSortTasks(tasks).map((t) => t.taskId),
    [1, 2],
  );
});

test('topoSortTasks: degrades gracefully for empty / null input', () => {
  assert.deepEqual(topoSortTasks([]), []);
  assert.deepEqual(topoSortTasks(null), []);
});

test('renderNestedWaveSections: renders Tasks in topo order with *(after #N)* callouts', () => {
  const stories = [
    {
      storyId: 500,
      storyTitle: 'Linear Story',
      type: 'story',
      earliestWave: 0,
      branchName: 'story-500',
      tasks: [
        // intentionally out-of-order to verify the sort, not the input.
        {
          taskId: 503,
          taskSlug: 't3',
          status: 'agent::ready',
          dependencies: [502],
        },
        {
          taskId: 501,
          taskSlug: 't1',
          status: 'agent::ready',
          dependencies: [],
        },
        {
          taskId: 502,
          taskSlug: 't2',
          status: 'agent::ready',
          dependencies: [501],
        },
      ],
    },
  ];
  const md = renderNestedWaveSections(stories);
  // Tasks render in topo order T1, T2, T3
  const idxT1 = md.indexOf('- [ ] #501 — t1');
  const idxT2 = md.indexOf('- [ ] #502 — t2 *(after #501)*');
  const idxT3 = md.indexOf('- [ ] #503 — t3 *(after #502)*');
  assert.ok(idxT1 >= 0, 'T1 line missing');
  assert.ok(idxT2 > idxT1, 'T2 should appear after T1');
  assert.ok(idxT3 > idxT2, 'T3 should appear after T2');
});

test('renderNestedWaveSections: omits *(after …)* callouts when no in-Story deps exist', () => {
  const stories = [
    {
      storyId: 600,
      storyTitle: 'Independent Story',
      type: 'story',
      earliestWave: 0,
      branchName: 'story-600',
      tasks: [
        {
          taskId: 601,
          taskSlug: 't1',
          status: 'agent::ready',
          dependencies: [],
        },
        {
          taskId: 602,
          taskSlug: 't2',
          status: 'agent::ready',
          dependencies: [],
        },
      ],
    },
  ];
  const md = renderNestedWaveSections(stories);
  assert.ok(md.includes('- [ ] #601 — t1\n'));
  assert.ok(md.includes('- [ ] #602 — t2\n'));
  assert.ok(!md.includes('*(after #'), 'should not emit any after-callouts');
});

test('renderNestedWaveSections: callout names the latest in-Story dependency when multiple exist', () => {
  const stories = [
    {
      storyId: 700,
      storyTitle: 'Diamond Story',
      type: 'story',
      earliestWave: 0,
      branchName: 'story-700',
      tasks: [
        {
          taskId: 701,
          taskSlug: 'root',
          status: 'agent::ready',
          dependencies: [],
        },
        {
          taskId: 702,
          taskSlug: 'left',
          status: 'agent::ready',
          dependencies: [701],
        },
        {
          taskId: 703,
          taskSlug: 'right',
          status: 'agent::ready',
          dependencies: [701],
        },
        // 704 depends on both: latest in topo order is the one whose work lands last.
        {
          taskId: 704,
          taskSlug: 'merge',
          status: 'agent::ready',
          dependencies: [702, 703],
        },
      ],
    },
  ];
  const md = renderNestedWaveSections(stories);
  // 703 sits later in the sorted order than 702 → that's the named dep.
  assert.ok(
    md.includes('- [ ] #704 — merge *(after #703)*'),
    `expected callout to name #703; rendered: ${md}`,
  );
});

test('computeStoryProgress: derives pct, done, total from story.tasks[]', () => {
  assert.deepEqual(
    computeStoryProgress({
      tasks: [{ status: 'agent::done' }, { status: 'agent::ready' }],
    }),
    { pct: 50, done: 1, total: 2 },
  );
  assert.deepEqual(computeStoryProgress({ tasks: [] }), {
    pct: 0,
    done: 0,
    total: 0,
  });
  assert.deepEqual(computeStoryProgress({}), { pct: 0, done: 0, total: 0 });
});
