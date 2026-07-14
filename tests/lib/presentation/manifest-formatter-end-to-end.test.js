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

// Story #4157: the per-wave H2 sections derive depth at render time from
// `dependsOn`, while the Wave Summary TOC still reads the persisted
// `earliestWave`. Each Story therefore carries explicit `dependsOn` edges
// onto a Story in the prior wave so the derived depth equals `earliestWave`
// and the TOC anchors round-trip to the H2s the depth lens emits.
function story(id, title, wave, status = 'agent::ready', deps = []) {
  return {
    storyId: id,
    storySlug: `story-${id}`,
    storyTitle: title,
    type: 'story',
    earliestWave: wave,
    dependsOn: deps,
    branchName: `story-${id}`,
    status,
  };
}

function buildE2EFixture() {
  // Wave 0: 2 stories (no dependencies → depth 0).
  const s100 = story(100, 'Sprint Bootstrap', 0);
  const s101 = story(101, 'Wire Telemetry', 0);

  // Wave 1: 2 stories, each depending on a Wave-0 Story → depth 1.
  const s200 = story(200, 'Render TOC', 1, 'agent::ready', [100]);
  const s201 = story(201, 'Nest Stories', 1, 'agent::ready', [101]);

  // Wave 2: 1 Story depending on a Wave-1 Story → depth 2.
  const s300 = story(300, 'Order Tasks', 2, 'agent::ready', [200]);

  return {
    epicId: 11780,
    epicTitle: 'Synthetic E2E Fixture Epic',
    generatedAt: '2026-05-11T00:00:00.000Z',
    summary: {
      totalStories: 5,
      doneStories: 0,
      progressPercent: 0,
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
          file: '.agents/workflows/helpers/deliver-story.md',
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

test('e2e fixture: header meta line folds done/total stories + wave count', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildE2EFixture());
  // No Sprint Progress hero anymore — meta line carries the totals.
  assert.doesNotMatch(md, /Sprint Progress/);
  assert.doesNotMatch(md, /^## (?:🏗️|🔥|🎉)/m);
  // Single `_Generated …_` line carries timestamp + Story-tier counts +
  // wave count. No residual Task-tier counts. The fixture has 5 stories
  // total, none done.
  assert.match(
    md,
    /_Generated 2026-05-11T00:00:00\.000Z · 0\/5 stories · 3 waves_/,
  );
  // The meta line carries no residual Task-tier count.
  const metaLine = md.match(/_Generated [^\n]*_/)?.[0] ?? '';
  assert.doesNotMatch(metaLine, /tasks/);
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

// The in-Story dep callout (`*(after #N)*`) and the per-Task checkbox
// rendering assertions were removed when Epic #3163 (Story #3196)
// collapsed the per-Story Task projection: Stories are leaves under
// the 2-tier hierarchy, so the renderer no longer emits checkbox rows
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
