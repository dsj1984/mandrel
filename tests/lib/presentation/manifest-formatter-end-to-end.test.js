/**
 * End-to-end manifest regeneration fixture.
 *
 * Renders a synthetic Epic with multiple waves, a cross-Story Task
 * dependency that survives Story-edge promotion, and inferred
 * file-contention edges through `formatManifestMarkdown`, then asserts
 * the post-cleanup layout (see `feat/manifest-ux-cleanup`):
 *
 *   • Title + subtitle + a single `_Generated …_` meta line that folds
 *     timestamp + done/total tasks + done/total stories + wave count
 *     (no separate Sprint Progress hero block, no follow-on counts
 *     blockquote).
 *   • Wave Summary TOC table — `Wave | Status | Stories | Tasks` (no
 *     Progress column; the Tasks cell already shows done/total).
 *   • Per-wave `## <emoji> Wave N` H2 (status word lives only in the
 *     TOC). Each H2 is followed by a one-line blockquote that adds a
 *     "gated on Wave M" tail for Blocked waves and a "N run in parallel"
 *     tail for Ready waves with multiple Stories.
 *   • Per-Story `### <symbol> #<id> — <title> · X/Y tasks` H3 (no branch
 *     backticks, no progress bar, no `~?` ETA placeholder).
 *   • Tasks render as native `- [x]`/`- [ ]` checkboxes in topo order
 *     with `*(after #N)*` callouts for in-Story dependencies only.
 *   • Exactly one bottom `<details>` block carrying the operating
 *     procedures + full symbol legend; no other HTML anywhere.
 *   • TOC anchors round-trip to the matching H2 via `slugifyHeading`.
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

test('e2e fixture: header meta line folds done/total tasks + stories + wave count', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  // No Sprint Progress hero anymore — meta line carries the totals.
  assert.doesNotMatch(md, /Sprint Progress/);
  assert.doesNotMatch(md, /^## (?:🏗️|🔥|🎉)/m);
  // Single `_Generated …_` line carries timestamp + tasks + stories +
  // wave count. Story #100 is the only one with all tasks done; the
  // fixture has 5 stories total.
  assert.match(
    md,
    /_Generated 2026-05-11T00:00:00\.000Z · 4\/14 tasks · 0\/5 stories · 3 waves_/,
  );
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

test('e2e fixture: first wave H2 follows the TOC table directly (no inline legend)', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  const tocPos = md.indexOf('| Wave | Status | Stories | Tasks |');
  const firstH2Pos = md.search(/^## (?:🚀|✅|⏳) Wave 0$/m);
  assert.ok(tocPos > 0, 'TOC table must render');
  assert.ok(firstH2Pos > tocPos, 'first wave H2 must sit after the TOC');
  // Inline legend was retired — full legend lives in the bottom <details>.
  assert.doesNotMatch(md, /\*\*Legend:\*\*/);
});

test('e2e fixture: per-Story heading carries done/total tasks (no branch, no bar, no ~?)', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  // Story #100: 2 of 3 tasks done.
  assert.match(
    md,
    /^### .* #100 — Sprint Bootstrap · 2\/3 tasks$/m,
    'Story #100 heading must carry done/total tasks',
  );
  // Story #200: 0 of 3 done.
  assert.match(
    md,
    /^### .* #200 — Render TOC · 0\/3 tasks$/m,
    'Story #200 heading must carry done/total tasks',
  );
  // Story #300 has a blocked Task → 🚧 symbol on the H3.
  assert.match(md, /^### 🚧 #300 — Order Tasks/m);
  // Decorations the old format carried are gone everywhere.
  assert.doesNotMatch(md, /`story-\d+`/, 'no branch backticks in H3s');
  assert.doesNotMatch(md, /~\?/, 'no ETA placeholder');
  // Per-Story progress bar removed (the long `[█░]+ NN%` ribbon is gone).
  assert.doesNotMatch(
    md
      .split('\n')
      .filter((l) => l.startsWith('### '))
      .join('\n'),
    /[█░]/,
    'no progress bar in H3s',
  );
});

// The in-Story dep callout (`*(after #N)*`) and the per-Task checkbox
// rendering assertions were removed when Epic #3163 (Story #3196)
// collapsed the per-Story Task projection: Stories are leaves under
// the 3-tier hierarchy, so the renderer no longer emits checkbox rows
// or dep callouts beneath a Story H3.

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
