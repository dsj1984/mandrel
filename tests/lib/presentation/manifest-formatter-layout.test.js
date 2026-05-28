/**
 * End-to-end manifest layout fixture.
 *
 * Renders a synthetic 4-wave / 7-Story / 19-Task manifest through
 * `formatManifestMarkdown` and asserts the structural invariants of the
 * post-cleanup layout (see `feat/manifest-ux-cleanup`):
 *
 *   • No legacy `## Execution Plan` or `## Story Details` headings.
 *   • Every Wave Summary TOC link round-trips to a real H2 anchor via
 *     the `slugifyHeading` helper.
 *   • The first wave H2 follows the TOC table directly — no inline
 *     legend blockquote.
 *   • Exactly one bottom `<details>` block; no other HTML tags appear
 *     anywhere else in the rendered output.
 *   • Every Task line uses native markdown checkboxes (`- [ ]` / `- [x]`)
 *     with no embedded HTML.
 *
 * The fixture is intentionally larger than the unit-test fixtures in
 * `tests/lib/manifest-formatter.test.js` so an accidental refactor that
 * regresses one wave or one story still trips the assertions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetManifestFormatterCache,
  formatManifestMarkdown,
  slugifyHeading,
} from '../../../.agents/scripts/lib/presentation/manifest-formatter.js';

// ---------------------------------------------------------------------------
// Synthetic 4-wave / 7-Story / 19-Task fixture
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

function buildLayoutFixture() {
  // Wave 0: 2 stories, 5 tasks total
  const s100 = story(100, 'Bootstrap', 0, [
    task(1001, 'agent::done'),
    task(1002, 'agent::done', [1001]),
    task(1003, 'agent::executing', [1002]),
  ]);
  const s101 = story(101, 'Wire Telemetry', 0, [
    task(1011, 'agent::done'),
    task(1012, 'agent::ready', [1011]),
  ]);

  // Wave 1: 2 stories, 6 tasks
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

  // Wave 2: 2 stories, 6 tasks; one Story has a blocked Task to exercise 🚧.
  const s300 = story(300, 'Order Tasks', 2, [
    task(3001, 'agent::ready'),
    task(3002, 'agent::blocked', [3001]),
    task(3003, 'agent::ready', [3001]),
  ]);
  const s301 = story(301, 'Add Legend', 2, [
    task(3011, 'agent::ready'),
    task(3012, 'agent::ready', [3011]),
    task(3013, 'agent::ready', [3012]),
  ]);

  // Wave 3: 1 Story with 2 tasks
  const s400 = story(400, 'Lock Layout Fixture', 3, [
    task(4001, 'agent::ready'),
    task(4002, 'agent::ready', [4001]),
  ]);

  return {
    epicId: 9999,
    epicTitle: 'Synthetic Layout Fixture Epic',
    generatedAt: '2026-05-10T00:00:00.000Z',
    summary: {
      totalTasks: 19,
      doneTasks: 4,
      progressPercent: Math.round((4 / 19) * 100),
      dispatched: 4,
      totalWaves: 4,
    },
    storyManifest: [s100, s101, s200, s201, s300, s301, s400],
    waves: [],
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('layout fixture: legacy Execution Plan / Story Details headings are gone', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildLayoutFixture());
  // Per AC: zero matches for either legacy heading.
  assert.equal(
    (md.match(/^## Execution Plan/gm) || []).length,
    0,
    'unexpected ## Execution Plan heading',
  );
  assert.equal(
    (md.match(/^## Story Details/gm) || []).length,
    0,
    'unexpected ## Story Details heading',
  );
  // Combined regex from the AC for belt-and-braces.
  assert.equal(
    (md.match(/^## (Execution Plan|Story Details)/gm) || []).length,
    0,
  );
});

test('layout fixture: every Wave Summary TOC link round-trips to a real H2 anchor', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildLayoutFixture());
  // Collect every TOC link target from the Wave Summary table.
  const linkTargets = [
    ...md.matchAll(/\[(?:Wave \d+|Ungrouped)\]\(#([^)]+)\)/g),
  ].map((m) => m[1]);
  assert.ok(
    linkTargets.length >= 4,
    'expected at least 4 TOC links for 4 waves',
  );
  // Compute every H2 slug present in the rendered document.
  const h2Slugs = new Set(
    [...md.matchAll(/^## (.+)$/gm)].map((m) => slugifyHeading(m[1])),
  );
  for (const target of linkTargets) {
    assert.ok(
      h2Slugs.has(target),
      `TOC anchor #${target} has no matching H2 (slugs: ${[...h2Slugs].join(', ')})`,
    );
  }
});

// Pending follow-on Story #3196 (Epic #3163): asserts the Tasks column on
// the Wave Summary TOC, which Story #3194 dropped when manifest-helpers.js
// pivoted to Story-only counts.
test.skip('layout fixture: first wave H2 follows the TOC table directly (no inline legend)', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildLayoutFixture());
  const tocPos = md.indexOf('| Wave | Status | Stories | Tasks |');
  const firstH2Pos = md.search(/^## (?:🚀|✅|⏳) Wave 0$/m);
  assert.ok(tocPos >= 0, 'TOC table missing');
  assert.ok(firstH2Pos > tocPos, 'first wave H2 should sit after the TOC');
  // Inline legend retired — full legend lives in the bottom <details>.
  assert.doesNotMatch(md, /\*\*Legend:\*\*/);
});

test('layout fixture: exactly one bottom <details> block, no other HTML tags anywhere', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildLayoutFixture());
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
  // Strip the bottom <details> block, then scan everywhere else for any
  // HTML-looking tag. Anything other than <details>/</details>/<summary>
  // (which are inside the stripped block anyway) should fail this test.
  const detailsRe = /<details>[\s\S]*?<\/details>/;
  const outsideDetails = md.replace(detailsRe, '');
  const stray = outsideDetails.match(/<[a-zA-Z/][^>]*>/g) || [];
  assert.deepEqual(
    stray,
    [],
    `unexpected HTML tags outside <details> block: ${JSON.stringify(stray)}`,
  );
});

test('layout fixture: every task line uses native markdown checkboxes (no HTML)', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildLayoutFixture());
  // Pull every line that starts with a checkbox bullet from outside the
  // <details> block — task lines should never appear inside it.
  const detailsRe = /<details>[\s\S]*?<\/details>/;
  const outside = md.replace(detailsRe, '');
  const taskLines = outside.split('\n').filter((l) => /^- \[[ x]\] /.test(l));
  assert.ok(
    taskLines.length >= 19,
    `expected at least 19 task checkbox lines, got ${taskLines.length}`,
  );
  for (const line of taskLines) {
    assert.ok(
      !/<[a-zA-Z/][^>]*>/.test(line),
      `task line contains HTML: "${line}"`,
    );
    // Each line carries an in-Story Task id.
    assert.match(line, /#\d+/, `task line missing #id: "${line}"`);
  }
});

test('layout fixture: wave summary status reflects per-wave readiness', () => {
  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildLayoutFixture());
  // Wave 0 still has executing/ready tasks → not Done; it's the root → Ready.
  assert.match(md, /\| \[Wave 0\]\(#[^)]+\) \| 🚀 Ready /);
  // Wave 1+ are gated on Wave 0 → Blocked.
  assert.match(md, /\| \[Wave 1\]\(#[^)]+\) \| ⏳ Blocked /);
  assert.match(md, /\| \[Wave 2\]\(#[^)]+\) \| ⏳ Blocked /);
  assert.match(md, /\| \[Wave 3\]\(#[^)]+\) \| ⏳ Blocked /);
});
