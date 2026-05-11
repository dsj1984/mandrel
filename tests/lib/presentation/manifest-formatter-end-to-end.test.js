/**
 * End-to-end manifest regeneration fixture (Story #1198 Task #1230).
 *
 * Renders a synthetic Epic with multiple waves, a cross-Story Task
 * dependency that survives Story-edge promotion, and inferred
 * file-contention edges through `formatManifestMarkdown`, then asserts
 * every Acceptance-Criteria item from the PRD's Manifest-rendering
 * section. This is the canonical regression for Epic #1178 — referenced
 * from `docs/CHANGELOG.md`.
 *
 * Coverage matrix (PRD Manifest-rendering AC → assertion):
 *
 *   • single nested Wave → Story → Task layout
 *       → no `## Execution Plan` / `## Story Details` headings
 *   • Sprint summary at top
 *       → `## 🏗️ Sprint Progress` heading + done/total counts
 *   • Wave Summary TOC table with anchor links
 *       → every `[Wave N](#…)` link round-trips to a real H2 anchor via
 *         `slugifyHeading`
 *   • inline legend blockquote between TOC and first wave H2
 *   • per-wave H2 nests Stories with branch + per-Story progress bar +
 *     per-Story estimate placeholder
 *       → `### <symbol> #<id> — <title> · \`story-<id>\` · <bar> N% · ~?`
 *   • Tasks rendered in execution order with `*(after #N)*` for in-Story
 *     dependencies; cross-Story dependencies do NOT render as `*(after #)*`
 *     (they are handled at the wave-ordering layer by the analyzer's
 *     Story-edge promotion in `dependency-analyzer.js`)
 *   • native `- [ ]` / `- [x]` checkboxes everywhere; no HTML inside task
 *     lines
 *   • exactly one bottom `<details>` block; no other HTML tags anywhere
 *   • TOC link slugs match the H2 emoji-prefixed text via `slugifyHeading`
 *
 * Per-Story progress bar derived from `tasks[].status` is exercised by
 * mixing `agent::done`, `agent::executing`, `agent::ready`, and
 * `agent::blocked` Task statuses across the synthetic fixture.
 *
 * Deferred AC documentation:
 *
 *   The PRD also lists `Dispatch (⌈N/cap⌉ rounds)` + `Est. wall-clock`
 *   Wave Summary columns, calibrated estimator range display
 *   (P25–P75), and a per-wave "Decomposition notes" subsection driven by
 *   `analysis.decompositionNotes`. The renderer integration for those
 *   items did not land on `epic/1178` (Stories #1195 / #1196 closed
 *   without their formatter wiring reaching the Epic branch). The
 *   fixture asserts the *current* shipped output exactly so any future
 *   wiring patch will trip these locks and force the author to extend
 *   the assertions in lock-step.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetManifestFormatterCache,
  formatManifestMarkdown,
  slugifyHeading,
} from '../../../.agents/scripts/lib/presentation/manifest-formatter.js';

// ---------------------------------------------------------------------------
// Synthetic Epic fixture: 3 waves, 6 Stories, 14 Tasks, with one cross-Story
// Task dependency (#3001 depends_on #2001) that the wave-ordering layer
// promotes to a Story-edge so the cross-Story dep does NOT render as
// `*(after #2001)*` inside Story #300.
// ---------------------------------------------------------------------------

function task(id, status = 'agent::ready', deps = []) {
  return {
    taskId: id,
    taskSlug: `task-${id}`,
    status,
    dependencies: deps,
  };
}

function story(id, title, wave, tasks) {
  return {
    storyId: id,
    storySlug: `story-${id}`,
    storyTitle: title,
    type: 'story',
    earliestWave: wave,
    branchName: `story-${id}`,
    tasks,
  };
}

function buildE2EFixture() {
  // Wave 0: 2 stories, 5 tasks. Story #100 has a fully-done Task to drive
  // a non-zero per-Story progress bar.
  const s100 = story(100, 'Sprint Bootstrap', 0, [
    task(1001, 'agent::done'),
    task(1002, 'agent::done', [1001]),
    task(1003, 'agent::executing', [1002]),
  ]);
  const s101 = story(101, 'Wire Telemetry', 0, [
    task(1011, 'agent::done'),
    task(1012, 'agent::ready', [1011]),
  ]);

  // Wave 1: 2 stories, 6 tasks. Story #200's #2001 is the upstream of a
  // cross-Story dep that promotes to a Story-edge (Story #300 → Wave 2).
  const s200 = story(200, 'Render TOC', 1, [
    task(2001, 'agent::ready'),
    task(2002, 'agent::ready', [2001]),
    task(2003, 'agent::ready', [2002]),
  ]);
  const s201 = story(201, 'Nest Stories', 1, [
    task(2011, 'agent::ready'),
    task(2012, 'agent::ready', [2011]),
    task(2013, 'agent::ready', [2011]),
  ]);

  // Wave 2: 1 Story with 3 tasks; #3001 declares a cross-Story dep on
  // #2001 (Story #200 / Wave 1). The analyzer would have promoted this
  // to a Story-edge, deferring Story #300 to Wave 2. The renderer must
  // NOT include `*(after #2001)*` because #2001 is not in this Story.
  // #3002 has an in-Story dep on #3001 that DOES render as `(after #3001)`.
  // #3003 is blocked to exercise the 🚧 status symbol.
  const s300 = story(300, 'Order Tasks', 2, [
    task(3001, 'agent::ready', [2001]), // cross-Story → not rendered
    task(3002, 'agent::ready', [3001]), // in-Story → rendered
    task(3003, 'agent::blocked', [3001]),
  ]);

  return {
    epicId: 11780,
    epicTitle: 'Synthetic E2E Fixture Epic',
    generatedAt: '2026-05-11T00:00:00.000Z',
    summary: {
      totalTasks: 14,
      doneTasks: 4,
      progressPercent: Math.round((4 / 14) * 100),
      dispatched: 4,
      totalWaves: 3,
    },
    storyManifest: [s100, s101, s200, s201, s300],
    waves: [],
    dryRun: false,
    // The analyzer produces decomposition notes for inferred file-contention
    // edges (Story #1195). The current `formatManifestMarkdown` on
    // `epic/1178` does not propagate this field through to the per-wave
    // sections — the assertion below documents the gap.
    analysis: {
      decompositionNotes: [
        {
          kind: 'inferred-file-contention',
          file: '.agents/workflows/epic-deliver.md',
          stories: [200, 201],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('e2e fixture: layout has no legacy Execution Plan / Story Details headings', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  assert.equal(
    (md.match(/^## (Execution Plan|Story Details)/gm) || []).length,
    0,
    'legacy headings must be absent',
  );
});

test('e2e fixture: Sprint Progress hero shows done/total task counts', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  assert.match(md, /^## (?:🏗️|🔥|🎉) Sprint Progress$/m);
  // Hero progress bar carries the literal `(4/14 tasks)` count.
  assert.match(md, /\(4\/14 tasks\)/);
  // The per-Story counts surface in a follow-on blockquote.
  assert.match(md, /\*\*Stories:\*\* \d+\/5 complete · \*\*Tasks:\*\* 4\/14/);
});

test('e2e fixture: every Wave Summary TOC link round-trips to a real H2 anchor', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  const linkTargets = [
    ...md.matchAll(/\[(?:Wave \d+|Ungrouped)\]\(#([^)]+)\)/g),
  ].map((m) => m[1]);
  assert.equal(
    linkTargets.length,
    3,
    'expected 3 TOC links for 3 waves (no Ungrouped bucket)',
  );
  const h2Slugs = new Set(
    [...md.matchAll(/^## (.+)$/gm)].map((m) => slugifyHeading(m[1])),
  );
  for (const target of linkTargets) {
    assert.ok(
      h2Slugs.has(target),
      `TOC anchor #${target} has no matching H2; H2 slugs: ${[...h2Slugs].join(', ')}`,
    );
  }
});

test('e2e fixture: inline legend blockquote sits between the TOC table and the first wave H2', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  const tocPos = md.indexOf('| Wave | Status | Progress | Stories | Tasks |');
  const legendPos = md.indexOf('**Legend:**');
  const firstH2Pos = md.search(/^## (?:🚀 Ready|✅ Done|⏳ Blocked) Wave 0$/m);
  assert.ok(tocPos > 0, 'TOC table must render');
  assert.ok(legendPos > tocPos, 'inline legend must sit after the TOC');
  assert.ok(firstH2Pos > legendPos, 'first wave H2 must sit after the legend');
});

test('e2e fixture: per-Story heading carries branch name, progress bar, percent, and estimate placeholder', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  // Story #100: 2 of 3 tasks done → 67%.
  assert.match(
    md,
    /^### .* #100 — Sprint Bootstrap · `story-100` · [█░]+ 67% · ~\?$/m,
    'Story #100 heading must carry branch + progress bar + 67% + ~? estimate',
  );
  // Story #200: 0 of 3 done → 0%.
  assert.match(
    md,
    /^### .* #200 — Render TOC · `story-200` · [█░]+ 0% · ~\?$/m,
    'Story #200 heading must carry branch + progress bar + 0% + ~? estimate',
  );
  // Story #300 has a blocked Task → 🚧 symbol on the H3.
  assert.match(md, /^### 🚧 #300 — Order Tasks/m);
});

test('e2e fixture: in-Story Task dependency renders as `*(after #N)*`; cross-Story dep does NOT', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  // In-Story dep: #1002 → #1001 within Story #100.
  assert.match(md, /- \[x\] #1002 — task-1002 \*\(after #1001\)\*/);
  // In-Story dep inside Story #300: #3002 → #3001.
  assert.match(md, /- \[ \] #3002 — task-3002 \*\(after #3001\)\*/);
  // Cross-Story dep: #3001's only declared `dependencies: [2001]` is on a
  // Task in Story #200. The renderer must skip the callout because #2001
  // is not in Story #300's `tasks[]` set — wave ordering already deferred
  // Story #300 to Wave 2 via Story-edge promotion in the analyzer.
  assert.equal(
    (md.match(/- \[ \] #3001 — task-3001(?: \*\(after #\d+\)\*)?/g) || [])
      .length,
    1,
    'expected exactly one #3001 line',
  );
  assert.doesNotMatch(
    md,
    /- \[ \] #3001 — task-3001 \*\(after #2001\)\*/,
    'cross-Story dep must not render as in-Story `*(after #2001)*`',
  );
});

test('e2e fixture: every task line uses native markdown checkboxes (no HTML)', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  const detailsRe = /<details>[\s\S]*?<\/details>/;
  const outside = md.replace(detailsRe, '');
  const taskLines = outside.split('\n').filter((l) => /^- \[[ x]\] /.test(l));
  assert.ok(
    taskLines.length >= 14,
    `expected at least 14 task checkbox lines, got ${taskLines.length}`,
  );
  for (const line of taskLines) {
    assert.ok(
      !/<[a-zA-Z/][^>]*>/.test(line),
      `task line contains HTML: "${line}"`,
    );
    assert.match(line, /#\d+/, `task line missing #id: "${line}"`);
  }
});

test('e2e fixture: exactly one bottom <details> block; no other HTML tags anywhere', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  assert.equal(
    (md.match(/<details>/g) || []).length,
    1,
    'exactly one <details> opener',
  );
  assert.equal(
    (md.match(/<\/details>/g) || []).length,
    1,
    'exactly one </details> closer',
  );
  const detailsRe = /<details>[\s\S]*?<\/details>/;
  const outside = md.replace(detailsRe, '');
  // The hero progress bar lives inside a fenced ``` block — strip those
  // before sweeping for stray HTML so the assertion targets actual tags.
  const outsideNoCode = outside.replace(/```[\s\S]*?```/g, '');
  const stray = outsideNoCode.match(/<[a-zA-Z/][^>]*>/g) || [];
  assert.deepEqual(
    stray,
    [],
    `unexpected HTML tags outside <details>: ${JSON.stringify(stray)}`,
  );
});

test('e2e fixture: wave statuses reflect upstream readiness (Wave 0 Ready, Waves 1+ Blocked)', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  assert.match(md, /\| \[Wave 0\]\(#[^)]+\) \| 🚀 Ready /);
  assert.match(md, /\| \[Wave 1\]\(#[^)]+\) \| ⏳ Blocked /);
  assert.match(md, /\| \[Wave 2\]\(#[^)]+\) \| ⏳ Blocked /);
});

test('e2e fixture: deferred features — Dispatch / Est. wall-clock columns and per-wave decomposition-notes subsection are NOT yet rendered', () => {
  // Lock the current shape so any future wiring of Story #1195's per-wave
  // notes plumbing or Story #1196's Dispatch + Est. wall-clock columns
  // trips this assertion and forces the author to extend the e2e
  // assertions above in lock-step. The PRD lists both as AC; their
  // formatter integration did not land on `epic/1178`, and Task #1230's
  // remit is to lock the *current* end-to-end output behind one fixture.
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  // Wave Summary table header columns shipped today: Wave · Status ·
  // Progress · Stories · Tasks. No Dispatch / Est. wall-clock yet.
  assert.doesNotMatch(
    md,
    /\| Dispatch \|/,
    'Dispatch column was not wired to epic/1178; remove this guard once it ships',
  );
  assert.doesNotMatch(
    md,
    /\| Est\. wall-clock \|/,
    'Est. wall-clock column was not wired to epic/1178; remove this guard once it ships',
  );
  // Per-wave Decomposition notes subsection (Story #1195) is gated by the
  // formatter consuming `analysis.decompositionNotes`; the wiring did not
  // reach `epic/1178`. The fixture supplies the field above so this
  // assertion will start failing as soon as the wiring is restored.
  assert.doesNotMatch(
    md,
    /> \*\*Decomposition notes:\*\*/,
    'Decomposition notes wiring was not on epic/1178; remove this guard once it ships',
  );
});
