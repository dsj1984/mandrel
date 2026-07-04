/**
 * Unit tests for `acceptance-spec-reconciler.js` — Story #2106 / Task #2113.
 *
 * Story #4324 retargeted the reconciler from the `context::acceptance-spec`
 * ticket to the Epic body's `## Acceptance Table` managed section. Every
 * pre-fold test intent is preserved against the new anchor; the fixtures
 * are mechanically retargeted (spec-ticket bodies → Epic-body sections).
 *
 * Covers:
 *   - Pure helpers: parseAcIds, collectScenarioTagSets, classifyCoverage,
 *     renderBlockerMessage, renderDispositions,
 *     classifyReconcilerInvocation.
 *   - End-to-end reconcileAcceptanceSpec with stubbed provider + filesystem.
 *   - Waiver short-circuit (acceptance::n-a label).
 *   - Missing-section throw (defence in depth past the start gate).
 *   - OK / pending / missing matrix.
 *   - Close-time disposition write-back — section-scoped (the Story #4324
 *     sentinel oracle: an unrelated edit elsewhere in the body survives the
 *     reconciler's write byte-for-byte).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acTagToken,
  classifyCoverage,
  classifyReconcilerInvocation,
  collectScenarioTagSets,
  parseAcIds,
  reconcileAcceptanceSpec,
  renderBlockerMessage,
  renderDispositions,
} from '../.agents/scripts/acceptance-spec-reconciler.js';
import {
  extractEpicSection,
  upsertEpicSection,
} from '../.agents/scripts/lib/epic-body-sections.js';
import { makeMockProvider } from './helpers/make-mock-provider.js';

function buildProvider(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const updates = [];
  return {
    updates,
    async getEpic(id) {
      const t = byId.get(id);
      if (!t) return null;
      return { ...t, labels: [...(t.labels ?? [])] };
    },
    async getTicket(id) {
      const t = byId.get(id);
      if (!t) return null;
      return { ...t, labels: [...(t.labels ?? [])] };
    },
    async updateTicket(id, patch) {
      updates.push({ id, patch });
      const t = byId.get(id);
      if (t && typeof patch?.body === 'string') t.body = patch.body;
      return { id };
    },
  };
}

/** Build a sectioned Epic body carrying an ## Acceptance Table region. */
function epicBodyWithTable(tableRows, { prose = '' } = {}) {
  const base = ['## Context', 'Some context.', prose]
    .filter(Boolean)
    .join('\n');
  const section = [
    '## Acceptance Table',
    '| AC ID | Outcome | Feature File | Scenario | Disposition |',
    '| --- | --- | --- | --- | --- |',
    ...tableRows,
  ].join('\n');
  return upsertEpicSection(base, 'acceptanceTable', section);
}

const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

describe('parseAcIds', () => {
  it('extracts stable AC IDs in document order, deduplicated', () => {
    const body =
      '## Acceptance Criteria\n' +
      '| AC ID | Outcome |\n| --- | --- |\n' +
      '| AC-1 | first |\n| AC-2 | second |\n| AC-1 | dupe — ignored |\n' +
      '| AC-7 | seven |\n';
    assert.deepEqual(parseAcIds(body), ['AC-1', 'AC-2', 'AC-7']);
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(parseAcIds(''), []);
    assert.deepEqual(parseAcIds(undefined), []);
    assert.deepEqual(parseAcIds(null), []);
  });

  it('is case-insensitive on the AC- prefix but normalises to upper', () => {
    assert.deepEqual(parseAcIds('something ac-3 then AC-4'), ['AC-3', 'AC-4']);
  });

  it('does not match BAC-7 or AC-X (word boundary + digit guard)', () => {
    assert.deepEqual(parseAcIds('BAC-7 and AC-X but real AC-5 here'), ['AC-5']);
  });
});

describe('collectScenarioTagSets', () => {
  it('parses tags per scenario, inheriting feature-level tags', () => {
    const feature = [
      '@feature-wide',
      'Feature: Sample',
      '',
      '@ac-1',
      'Scenario: first',
      '  Given x',
      '',
      '@ac-2 @pending',
      'Scenario: second',
      '  Given y',
    ].join('\n');
    const sets = collectScenarioTagSets(feature);
    assert.equal(sets.length, 2);
    assert.ok(sets[0].has('ac-1'));
    assert.ok(sets[0].has('feature-wide'));
    assert.ok(!sets[0].has('pending'));
    assert.ok(sets[1].has('ac-2'));
    assert.ok(sets[1].has('pending'));
    assert.ok(sets[1].has('feature-wide'));
  });

  it('handles Scenario Outline and ignores comment lines', () => {
    const feature = [
      'Feature: Outlines',
      '# a comment',
      '@ac-9',
      'Scenario Outline: parametric',
      '  Given <x>',
    ].join('\n');
    const sets = collectScenarioTagSets(feature);
    assert.equal(sets.length, 1);
    assert.ok(sets[0].has('ac-9'));
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(collectScenarioTagSets(''), []);
    assert.deepEqual(collectScenarioTagSets(undefined), []);
  });

  it('does not attach orphan tags separated by a blank line', () => {
    const feature = [
      'Feature: orphan',
      '',
      '@stray',
      '', // blank line breaks the tag block
      'Scenario: not-tagged',
      '  Given x',
    ].join('\n');
    const sets = collectScenarioTagSets(feature);
    assert.equal(sets.length, 1);
    assert.ok(!sets[0].has('stray'));
  });
});

describe('classifyCoverage', () => {
  it('marks an AC satisfied when a non-pending scenario carries the tag', () => {
    const tagSets = [new Set(['ac-1']), new Set(['ac-1', 'pending'])];
    const out = classifyCoverage({ acIds: ['AC-1'], tagSets });
    assert.deepEqual(out, { satisfied: ['AC-1'], pending: [], missing: [] });
  });

  it('marks an AC pending when only @pending scenarios carry the tag', () => {
    const tagSets = [new Set(['ac-2', 'pending'])];
    const out = classifyCoverage({ acIds: ['AC-2'], tagSets });
    assert.deepEqual(out, { satisfied: [], pending: ['AC-2'], missing: [] });
  });

  it('marks an AC missing when no scenario carries the tag', () => {
    const tagSets = [new Set(['ac-1'])];
    const out = classifyCoverage({ acIds: ['AC-3'], tagSets });
    assert.deepEqual(out, { satisfied: [], pending: [], missing: ['AC-3'] });
  });

  it('mixed matrix: classifies each AC independently', () => {
    const tagSets = [
      new Set(['ac-1']), // AC-1 satisfied
      new Set(['ac-2', 'pending']), // AC-2 pending-only
      // AC-3: nothing
    ];
    const out = classifyCoverage({
      acIds: ['AC-1', 'AC-2', 'AC-3'],
      tagSets,
    });
    assert.deepEqual(out.satisfied, ['AC-1']);
    assert.deepEqual(out.pending, ['AC-2']);
    assert.deepEqual(out.missing, ['AC-3']);
  });

  it('with epicId, matches only the per-epic namespaced tag (Story #3362)', () => {
    // Scenario carries the namespaced tag for THIS epic → satisfied.
    const tagSets = [new Set(['epic-1241-ac-1'])];
    const out = classifyCoverage({ acIds: ['AC-1'], tagSets, epicId: 1241 });
    assert.deepEqual(out, { satisfied: ['AC-1'], pending: [], missing: [] });
  });

  it('with epicId, ignores a bare @ac-N tag from an unrelated epic (Story #3362)', () => {
    // This is the cross-epic leak: a bare `ac-1` (and another epic's
    // namespaced tag) must NOT count as coverage for epic 1241.
    const tagSets = [new Set(['ac-1']), new Set(['epic-9999-ac-1'])];
    const out = classifyCoverage({ acIds: ['AC-1'], tagSets, epicId: 1241 });
    assert.deepEqual(out, { satisfied: [], pending: [], missing: ['AC-1'] });
  });

  it('with epicId, a foreign @skip @ac-N does not count as pending (Story #3362)', () => {
    // The reported symptom: AC-10 read off a `@skip @ac-10` in another
    // epic's deploy/emergency-hotfix.feature → false pending block.
    const tagSets = [new Set(['ac-10', 'skip'])];
    const out = classifyCoverage({ acIds: ['AC-10'], tagSets, epicId: 1241 });
    assert.deepEqual(out, { satisfied: [], pending: [], missing: ['AC-10'] });
  });
});

describe('acTagToken', () => {
  it('namespaces the token per epic when epicId is a positive integer', () => {
    assert.equal(acTagToken('AC-7', 1241), 'epic-1241-ac-7');
  });
  it('falls back to the bare lower-cased token without an epicId', () => {
    assert.equal(acTagToken('AC-7'), 'ac-7');
    assert.equal(acTagToken('AC-7', null), 'ac-7');
    assert.equal(acTagToken('AC-7', 0), 'ac-7');
  });
});

describe('classifyReconcilerInvocation', () => {
  it('--help → help intent', () => {
    assert.deepEqual(classifyReconcilerInvocation({ help: true }), {
      kind: 'help',
    });
  });
  it('missing --epic → usage-error', () => {
    const r = classifyReconcilerInvocation({});
    assert.equal(r.kind, 'usage-error');
    assert.ok(r.messages.some((m) => /required/.test(m)));
  });
  it('invalid --epic → usage-error', () => {
    assert.equal(
      classifyReconcilerInvocation({ epic: '0' }).kind,
      'usage-error',
    );
    assert.equal(
      classifyReconcilerInvocation({ epic: 'abc' }).kind,
      'usage-error',
    );
  });
  it('valid --epic → run intent', () => {
    assert.deepEqual(classifyReconcilerInvocation({ epic: '2001' }), {
      kind: 'run',
      epicId: 2001,
      featuresDir: null,
      skipWhenWaived: false,
      writeDispositions: false,
    });
  });
  it('passes --write-dispositions through', () => {
    const r = classifyReconcilerInvocation({
      epic: '7',
      'write-dispositions': true,
    });
    assert.equal(r.writeDispositions, true);
  });
  it('passes --features-dir through', () => {
    const r = classifyReconcilerInvocation({
      epic: '7',
      'features-dir': 'custom/feats',
    });
    assert.equal(r.featuresDir, 'custom/feats');
  });
});

describe('renderBlockerMessage', () => {
  it('includes both missing and pending sections when populated', () => {
    const msg = renderBlockerMessage({
      epicId: 99,
      missing: ['AC-1'],
      pending: ['AC-2'],
    });
    assert.match(msg, /Epic #99/);
    assert.match(msg, /## Acceptance Table/);
    assert.match(msg, /Missing.*AC-1/);
    assert.match(msg, /Pending.*AC-2/);
  });
});

describe('renderDispositions', () => {
  const SECTION = [
    '## Acceptance Table',
    '| AC ID | Outcome | Feature File | Scenario | Disposition |',
    '| --- | --- | --- | --- | --- |',
    '| AC-1 | one | a.feature | s1 | new |',
    '| AC-2 | two | b.feature | s2 | updated |',
    '| AC-3 | three | c.feature | s3 | unchanged |',
    '',
    'Prose after the table stays untouched.',
  ].join('\n');

  it('rewrites only the Disposition cell of classified AC rows', () => {
    const out = renderDispositions(SECTION, {
      satisfied: ['AC-1'],
      pending: ['AC-2'],
      missing: ['AC-3'],
    });
    assert.match(out, /\| AC-1 \| one \| a\.feature \| s1 \| satisfied \|/);
    assert.match(out, /\| AC-2 \| two \| b\.feature \| s2 \| pending \|/);
    assert.match(out, /\| AC-3 \| three \| c\.feature \| s3 \| missing \|/);
    // Header, divider, and prose pass through verbatim.
    assert.match(
      out,
      /\| AC ID \| Outcome \| Feature File \| Scenario \| Disposition \|/,
    );
    assert.match(out, /Prose after the table stays untouched\./);
  });

  it('leaves unclassified rows and non-table lines untouched', () => {
    const out = renderDispositions(SECTION, {
      satisfied: ['AC-1'],
      pending: [],
      missing: [],
    });
    assert.match(out, /\| AC-2 \| two \| b\.feature \| s2 \| updated \|/);
    assert.match(out, /\| AC-3 \| three \| c\.feature \| s3 \| unchanged \|/);
  });
});

describe('reconcileAcceptanceSpec', () => {
  it('throws on non-positive epicId', async () => {
    await assert.rejects(
      () => reconcileAcceptanceSpec({ epicId: 0 }),
      /positive integer/,
    );
  });

  it('returns waived status when acceptance::n-a label is present', async () => {
    // The reconciler reads `epic.labels` via provider.getEpic() (preferred)
    // or provider.getTicket() (fallback). makeMockProvider's default
    // `labels: ['acceptance::n-a']` is the load-bearing waiver — if it
    // were ever removed from the helper, this test would flip to a
    // status::missing-spec throw instead of `waived`.
    const provider = makeMockProvider();
    const out = await reconcileAcceptanceSpec({
      epicId: 7000,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => [],
    });
    assert.equal(out.status, 'waived');
    assert.equal(out.ok, true);
  });

  it('throws when the acceptance-table section is absent and waiver absent', async () => {
    const provider = buildProvider([
      { id: 7001, labels: ['type::epic'], body: '## Context\nno table here' },
    ]);
    await assert.rejects(
      () =>
        reconcileAcceptanceSpec({
          epicId: 7001,
          cwd: process.cwd(),
          injectedProvider: provider,
          injectedConfig: {},
          loggerImpl: SILENT_LOGGER,
          listFeatureFiles: () => [],
        }),
      /no ## Acceptance Table section/,
    );
  });

  it('returns waived when the section is absent and skipWhenWaived is set', async () => {
    const provider = buildProvider([
      { id: 7010, labels: ['type::epic'], body: '## Context\nno table here' },
    ]);
    const out = await reconcileAcceptanceSpec({
      epicId: 7010,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      skipWhenWaived: true,
      listFeatureFiles: () => [],
    });
    assert.equal(out.status, 'waived');
    assert.equal(out.ok, true);
  });

  it('ok=true and exits cleanly when all AC IDs are satisfied', async () => {
    const provider = buildProvider([
      {
        id: 7002,
        labels: ['type::epic'],
        body: epicBodyWithTable([
          '| AC-1 | Outcome | a.feature | s1 | new |',
          '| AC-2 | Outcome two | b.feature | s2 | new |',
        ]),
      },
    ]);
    const featureContent = [
      'Feature: Sample',
      '@epic-7002-ac-1',
      'Scenario: first',
      '  Given x',
      '',
      '@epic-7002-ac-2',
      'Scenario: second',
      '  Given y',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 7002,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/a.feature'],
      readFeatureFile: () => featureContent,
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.ok, true);
    assert.deepEqual(out.satisfied, ['AC-1', 'AC-2']);
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.pending, []);
  });

  it('ok=false with AC in missing[] when scenario tag is absent', async () => {
    const provider = buildProvider([
      {
        id: 7003,
        labels: ['type::epic'],
        body: epicBodyWithTable([
          '| AC-1 | a | a.feature | s1 | new |',
          '| AC-2 | b | b.feature | s2 | new |',
          '| AC-3 | c | c.feature | s3 | new |',
        ]),
      },
    ]);
    const featureContent = [
      'Feature: Sample',
      '@epic-7003-ac-1',
      'Scenario: only one',
      '  Given x',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 7003,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/a.feature'],
      readFeatureFile: () => featureContent,
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 'gap');
    assert.deepEqual(out.satisfied, ['AC-1']);
    assert.deepEqual(out.missing, ['AC-2', 'AC-3']);
  });

  it('ok=false with AC in pending[] when only @pending scenarios cover it', async () => {
    const provider = buildProvider([
      {
        id: 7004,
        labels: ['type::epic'],
        body: epicBodyWithTable([
          '| AC-1 | a | a.feature | s1 | new |',
          '| AC-2 | b | b.feature | s2 | new |',
        ]),
      },
    ]);
    const featureContent = [
      'Feature: Sample',
      '@epic-7004-ac-1',
      'Scenario: first',
      '  Given x',
      '',
      '@epic-7004-ac-2 @pending',
      'Scenario: pending one',
      '  Given y',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 7004,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/a.feature'],
      readFeatureFile: () => featureContent,
    });
    assert.equal(out.ok, false);
    assert.deepEqual(out.satisfied, ['AC-1']);
    assert.deepEqual(out.pending, ['AC-2']);
    assert.deepEqual(out.missing, []);
  });

  it('returns status=empty-spec when the section has no AC IDs', async () => {
    const provider = buildProvider([
      {
        id: 7005,
        labels: ['type::epic'],
        body: upsertEpicSection(
          '## Context\nx',
          'acceptanceTable',
          '## Acceptance Table\nno AC rows authored yet',
        ),
      },
    ]);
    const out = await reconcileAcceptanceSpec({
      epicId: 7005,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => [],
    });
    assert.equal(out.status, 'empty-spec');
    assert.equal(out.ok, true);
  });

  it("does not satisfy AC IDs from another epic's bare @ac-N scenarios (Story #3362)", async () => {
    // Reproduces the #1241 leak: a CLI epic declares AC-1..AC-2 but authored
    // zero of its OWN scenarios; unrelated epics' feature files carry bare
    // @ac-1 / @skip @ac-2. With per-epic namespacing those must NOT count.
    const provider = buildProvider([
      {
        id: 1241,
        labels: ['type::epic'],
        body: epicBodyWithTable([
          '| AC-1 | a | a.feature | s1 | new |',
          '| AC-2 | b | b.feature | s2 | new |',
        ]),
      },
    ]);
    const foreignFeature = [
      'Feature: analytics (epic 1242)',
      '@ac-1',
      'Scenario: unrelated',
      '  Given x',
      '',
      '@skip @ac-2',
      'Scenario: skipped unrelated',
      '  Given y',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 1241,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/analytics.feature'],
      readFeatureFile: () => foreignFeature,
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 'gap');
    assert.deepEqual(out.satisfied, []);
    assert.deepEqual(out.missing, ['AC-1', 'AC-2']);
  });

  // Story #4301 — regression for the wave-0 BDD scaffold bug: scaffolded
  // scenarios carry @skip AND the namespaced @epic-<id>-ac-N tag from the
  // SAME scaffolding pass (not deferred to de-skip). The reconciler must
  // report `satisfied` (not `missing`) once the scenario is also de-skipped,
  // proving the namespaced tag — present from scaffold time — is what the
  // reconciler actually keys on (the @skip tag itself is irrelevant to
  // classifyCoverage; only the AC tag and @pending matter).
  it('reports satisfied (not missing) for a wave-0-scaffolded-and-tagged, then de-skipped, scenario (Story #4301)', async () => {
    const provider = buildProvider([
      {
        id: 4301,
        labels: ['type::epic'],
        body: epicBodyWithTable([
          '| AC-1 | Invoice created | tests/features/billing/invoice.feature | Create invoice | new |',
        ]),
      },
    ]);
    // Simulates the wave-0 scaffold Story's output: @epic-4301-ac-1 is
    // present from scaffold time alongside @skip (per the corrected
    // decompose-author contract). A later implementation Story removes
    // @skip without touching the AC tag.
    const scaffoldedThenDeskipped = [
      'Feature: Billing',
      '@epic-4301-ac-1',
      'Scenario: Create invoice',
      '  Given a customer',
      '  When they create an invoice',
      '  Then the invoice exists',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 4301,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/billing/invoice.feature'],
      readFeatureFile: () => scaffoldedThenDeskipped,
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.ok, true);
    assert.deepEqual(out.satisfied, ['AC-1']);
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.pending, []);
  });

  // The bug being fixed: a scaffold that ONLY carries @skip (the
  // pre-Story-#4301 contract) leaves the AC unmatched even after de-skip,
  // because the namespaced tag was never authored at scaffold time.
  it('reproduces the pre-fix bug: a @skip-only scaffold (no namespaced AC tag) reads as missing (Story #4301)', async () => {
    const provider = buildProvider([
      {
        id: 4302,
        labels: ['type::epic'],
        body: epicBodyWithTable([
          '| AC-1 | Invoice created | tests/features/billing/invoice.feature | Create invoice | new |',
        ]),
      },
    ]);
    const skipOnlyScaffold = [
      'Feature: Billing',
      '@skip',
      'Scenario: Create invoice',
      '  Given a customer',
      '  When they create an invoice',
      '  Then the invoice exists',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 4302,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/billing/invoice.feature'],
      readFeatureFile: () => skipOnlyScaffold,
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 'gap');
    assert.deepEqual(out.missing, ['AC-1']);
  });

  // Story #4324 forward-only cutover: a historical Epic's legacy
  // `## Planning Artifacts` list (pointing at retired context tickets) is
  // ignored — never fetched — and does not shadow the managed section.
  it('ignores a legacy Planning Artifacts list and reads only the managed section', async () => {
    const legacyBody = `${epicBodyWithTable([
      '| AC-1 | x | a.feature | s1 | new |',
    ])}\n\n## Planning Artifacts\n- [x] Acceptance Spec: #7600\n`;
    const provider = buildProvider([
      { id: 7006, labels: ['type::epic'], body: legacyBody },
      // #7600 deliberately NOT registered — a fetch attempt would return
      // null and blow up downstream, proving legacy links are not fetched.
    ]);
    const out = await reconcileAcceptanceSpec({
      epicId: 7006,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: {},
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => [],
    });
    assert.deepEqual(out.missing, ['AC-1']);
    assert.equal(out.ok, false);
  });

  describe('close-time disposition write-back (Story #4324)', () => {
    const ROWS = [
      '| AC-1 | one | a.feature | s1 | new |',
      '| AC-2 | two | b.feature | s2 | new |',
    ];
    const FEATURE = [
      'Feature: Sample',
      '@epic-8000-ac-1',
      'Scenario: first',
      '  Given x',
    ].join('\n');

    it('records satisfied/missing into the Disposition column, section-scoped', async () => {
      const SENTINEL =
        'operator-authored prose SENTINEL-4324 outside the table';
      const provider = buildProvider([
        {
          id: 8000,
          labels: ['type::epic'],
          body: epicBodyWithTable(ROWS, { prose: SENTINEL }),
        },
      ]);
      const before = (await provider.getEpic(8000)).body;
      const out = await reconcileAcceptanceSpec({
        epicId: 8000,
        cwd: process.cwd(),
        injectedProvider: provider,
        injectedConfig: {},
        loggerImpl: SILENT_LOGGER,
        writeDispositions: true,
        listFeatureFiles: () => ['/fake/a.feature'],
        readFeatureFile: () => FEATURE,
      });
      assert.equal(out.dispositionsUpdated, true);
      assert.equal(provider.updates.length, 1);
      const after = provider.updates[0].patch.body;
      const section = extractEpicSection(after, 'acceptanceTable');
      assert.match(
        section,
        /\| AC-1 \| one \| a\.feature \| s1 \| satisfied \|/,
      );
      assert.match(section, /\| AC-2 \| two \| b\.feature \| s2 \| missing \|/);
      // Sentinel oracle: everything OUTSIDE the managed section is
      // byte-identical — the reconciler writes only its own region.
      const stripRegion = (body) =>
        body.replace(
          /<!-- mandrel:acceptance-table:start -->[\s\S]*<!-- mandrel:acceptance-table:end -->/,
          '<REGION>',
        );
      assert.equal(stripRegion(after), stripRegion(before));
      assert.ok(after.includes(SENTINEL));
    });

    it('does not write when writeDispositions is false (default)', async () => {
      const provider = buildProvider([
        { id: 8001, labels: ['type::epic'], body: epicBodyWithTable(ROWS) },
      ]);
      const out = await reconcileAcceptanceSpec({
        epicId: 8001,
        cwd: process.cwd(),
        injectedProvider: provider,
        injectedConfig: {},
        loggerImpl: SILENT_LOGGER,
        listFeatureFiles: () => ['/fake/a.feature'],
        readFeatureFile: () => FEATURE.replaceAll('8000', '8001'),
      });
      assert.equal(out.dispositionsUpdated, false);
      assert.equal(provider.updates.length, 0);
    });

    it('a failed write downgrades to a warning and never changes the verdict', async () => {
      const provider = buildProvider([
        { id: 8002, labels: ['type::epic'], body: epicBodyWithTable(ROWS) },
      ]);
      provider.updateTicket = async () => {
        throw new Error('boom: secondary rate limit');
      };
      const out = await reconcileAcceptanceSpec({
        epicId: 8002,
        cwd: process.cwd(),
        injectedProvider: provider,
        injectedConfig: {},
        loggerImpl: SILENT_LOGGER,
        writeDispositions: true,
        listFeatureFiles: () => ['/fake/a.feature'],
        readFeatureFile: () => FEATURE.replaceAll('8000', '8002'),
      });
      assert.equal(out.dispositionsUpdated, false);
      assert.equal(out.status, 'gap');
      assert.deepEqual(out.satisfied, ['AC-1']);
      assert.deepEqual(out.missing, ['AC-2']);
    });
  });
});
