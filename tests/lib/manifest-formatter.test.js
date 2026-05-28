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

// Pending follow-on Story #3195/#3196 (Epic #3163): renderNestedWaveSections
// still walks story.tasks[]; the TOC table column shape and per-Story body
// rendering pivot to Story-only counts once those Stories land. Reinstate
// the layout assertions then.
test.skip('formatter: renders epic header, meta line, wave TOC, and nested H2/H3 layout', () => {
  const md = formatManifestMarkdown(epicManifest());
  assert.ok(md.includes('# 📋 Dispatch Manifest — Epic #42'));
  assert.ok(md.includes('> **Demo Epic**'));
  // Meta line folds timestamp + totals on one line; no separate hero section.
  assert.ok(md.includes('1/4 tasks · 0/2 stories · 2 waves'));
  assert.ok(!md.includes('## 🏗️ Sprint Progress'));
  assert.ok(!md.includes('Sprint Progress'));
  // TOC table — no Progress column (Tasks already shows done/total).
  assert.ok(md.includes('## Wave Summary'));
  assert.ok(md.includes('| Wave | Status | Stories | Tasks |'));
  assert.ok(!md.includes('| Wave | Status | Progress |'));
  // Per-wave H2 carries emoji + label only (status word lives in the TOC).
  assert.ok(md.includes('## 🚀 Wave 0'));
  assert.ok(md.includes('## ⏳ Wave 1'));
  assert.ok(!md.includes('## 🚀 Ready Wave 0'));
  // Per-Story H3 carries symbol, #id, title, done/total tasks. No branch
  // backticks, no progress bar, no `~?` ETA placeholder.
  assert.ok(md.includes('### 🔄 #101 — Alpha Story · 1/2 tasks'));
  assert.ok(!md.includes('`story-101`'));
  assert.ok(!md.includes('~?'));
  // Tasks render as plain checkbox lines
  assert.ok(md.includes('- [x] #201 — t-a1'));
  assert.ok(md.includes('- [ ] #203 — t-b1'));
  // Legacy headings are gone
  assert.ok(!md.includes('## Execution Plan'));
  assert.ok(!md.includes('## Story Details'));
  // Inline legend blockquote retired — full legend lives in <details>.
  assert.ok(!md.includes('**Legend:**'));
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

// Pending follow-on Story #3196 (Epic #3163): per-Story H3 emoji now comes
// from deriveStorySymbol(story.status) — fixtures here predate the
// Story-only shape; reinstate after #3196 rewrites renderNestedWaveSections.
test.skip('renderNestedWaveSections: emits one ## emoji Wave N H2 per wave with H3 stories and checkbox tasks', () => {
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
  // One H2 per wave; legacy headings gone; status word stays out of the
  // heading (it's already in the Wave Summary table).
  assert.ok(!md.includes('## Execution Plan'));
  assert.ok(!md.includes('## Story Details'));
  const w0 = md.match(/^## 🚀 Wave 0$/gm) || [];
  const w1 = md.match(/^## ⏳ Wave 1$/gm) || [];
  assert.equal(w0.length, 1, 'exactly one Wave 0 H2');
  assert.equal(w1.length, 1, 'exactly one Wave 1 H2');
  // Wave 1 is Blocked → tail names the gating wave.
  assert.ok(md.includes('· gated on Wave 0'));
  // Wave 0 is Ready with 1 story → no parallel tail.
  // Switch Story 103 into Wave 0 to exercise the parallel hint.
  const md2 = renderNestedWaveSections([
    ...manifest.storyManifest.slice(0, 1),
    { ...manifest.storyManifest[2], earliestWave: 0 },
  ]);
  assert.ok(md2.includes('· 2 run in parallel'));
  // Per-Story H3: symbol + #id + title + done/total tasks; no branch
  // backticks, no progress bar, no `~?` ETA placeholder.
  assert.ok(md.includes('### 🔄 #101 — Alpha Story · 1/2 tasks'));
  assert.ok(!md.includes('`story-101`'));
  assert.ok(!md.includes('~?'));
  assert.ok(!/### 🔄 #101.*[█░]/.test(md));
  // Tasks rendered as plain checkbox lines (no HTML, no bold)
  assert.ok(md.includes('- [x] #201 — t-a1'));
  assert.ok(md.includes('- [ ] #205 — t-c1'));
});

// Pending follow-on Story #3196 (Epic #3163): per-Story H3 emoji derives
// from story.status in the new shape; fixture needs explicit status.
test.skip('renderNestedWaveSections: appends a Feature Containers section when present', () => {
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

// Pending follow-on Story #3196 (Epic #3163): topoSortTasks moved out of
// manifest-helpers.js (Story #3194) into manifest-render-waves.js as a
// private helper, where its only caller lives. Story #3196 rewrites
// renderNestedWaveSections to drop Task-tier rendering and deletes the
// helper outright; these tests reinstate against whatever Story-tier
// ordering helper survives that rewrite, or are deleted with rationale.
test.skip('topoSortTasks: orders T1 → T2 → T3 root-first when T2 deps T1, T3 deps T2', () => {});
test.skip('topoSortTasks: preserves declaration order when no edges exist', () => {});
test.skip('topoSortTasks: ignores cross-Story dependency ids', () => {});
test.skip('topoSortTasks: degrades gracefully for empty / null input', () => {});

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

// Pending follow-on Story #3196 (Epic #3163): computeStoryProgress moved out
// of manifest-helpers.js (Story #3194) into manifest-render-waves.js as a
// private helper alongside topoSortTasks. Story #3196 deletes both when
// the renderer pivots to Story-only progress; reinstate or drop with
// rationale at that point.
test.skip('computeStoryProgress: derives pct, done, total from story.tasks[]', () => {});

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

// Pending follow-on Story #3196 (Epic #3163): asserts TOC column header
// and Wave-0 H2 ordering, both of which depend on renderNestedWaveSections
// still walking story.tasks[]. Reinstate after #3196 rewrites the renderer
// for Story-only manifests.
test.skip('formatManifestMarkdown: bottom <details> block is the only HTML; first wave H2 follows the TOC directly', () => {
  const md = formatManifestMarkdown(epicManifest());
  // Exactly one <details> tag pair in the entire rendered document.
  assert.equal(
    (md.match(/<details>/g) || []).length,
    1,
    'expected exactly one <details> tag',
  );
  assert.equal(
    (md.match(/<\/details>/g) || []).length,
    1,
    'expected exactly one </details> tag',
  );
  // Strip the details block, then assert the rest contains no HTML tags.
  const detailsRe = /<details>[\s\S]*?<\/details>/;
  const outsideDetails = md.replace(detailsRe, '');
  const stray = outsideDetails.match(/<[a-zA-Z/][^>]*>/g) || [];
  assert.deepEqual(
    stray,
    [],
    `unexpected HTML tags outside <details> block: ${JSON.stringify(stray)}`,
  );
  // No inline legend — full legend lives in <details> only.
  assert.ok(!md.includes('**Legend:**'));
  // First wave H2 follows the TOC table directly.
  const tocPos = md.indexOf('| Wave | Status | Stories | Tasks |');
  const firstH2Pos = md.search(/^## 🚀 Wave 0$/m);
  assert.ok(tocPos >= 0, 'TOC table missing');
  assert.ok(firstH2Pos > tocPos, 'first wave H2 should follow the TOC');
  // No top-level "## 🤖 Agent Operating Procedures" or Sprint Progress
  // headings anymore — both folded into the meta line / details block.
  assert.ok(!md.includes('## 🤖 Agent Operating Procedures'));
  assert.ok(!md.includes('Sprint Progress'));
});
