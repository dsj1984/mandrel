/**
 * Unit tests for `acceptance-spec-reconciler.js` — Story #2106 / Task #2113.
 *
 * Covers:
 *   - Pure helpers: parseAcIds, collectScenarioTagSets, classifyCoverage,
 *     renderBlockerMessage, classifyReconcilerInvocation.
 *   - End-to-end reconcileAcceptanceSpec with stubbed provider + filesystem.
 *   - Waiver short-circuit (acceptance::n-a label).
 *   - Missing-spec throw (defence in depth past the start gate).
 *   - OK / pending / missing matrix.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyCoverage,
  classifyReconcilerInvocation,
  collectScenarioTagSets,
  parseAcIds,
  reconcileAcceptanceSpec,
  renderBlockerMessage,
} from '../.agents/scripts/acceptance-spec-reconciler.js';
import { makeMockProvider } from './helpers/make-mock-provider.js';

function buildProvider(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  return {
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
  };
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
    });
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
      acceptanceSpecId: 100,
      missing: ['AC-1'],
      pending: ['AC-2'],
    });
    assert.match(msg, /Epic #99/);
    assert.match(msg, /#100/);
    assert.match(msg, /Missing.*AC-1/);
    assert.match(msg, /Pending.*AC-2/);
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
      injectedConfig: { agentSettings: {}, orchestration: {} },
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => [],
    });
    assert.equal(out.status, 'waived');
    assert.equal(out.ok, true);
  });

  it('throws when no acceptance-spec linked and waiver absent', async () => {
    const provider = buildProvider([
      { id: 7001, labels: ['type::epic'], body: '', linkedIssues: null },
    ]);
    await assert.rejects(
      () =>
        reconcileAcceptanceSpec({
          epicId: 7001,
          cwd: process.cwd(),
          injectedProvider: provider,
          injectedConfig: { agentSettings: {}, orchestration: {} },
          loggerImpl: SILENT_LOGGER,
          listFeatureFiles: () => [],
        }),
      /no linked context::acceptance-spec/,
    );
  });

  it('ok=true and exits cleanly when all AC IDs are satisfied', async () => {
    const provider = buildProvider([
      {
        id: 7002,
        labels: ['type::epic'],
        body: '## Planning Artifacts\n- [x] Acceptance Spec: #7500\n',
      },
      {
        id: 7500,
        labels: ['context::acceptance-spec'],
        body: '| AC-1 | Outcome |\n| AC-2 | Outcome two |\n',
        state: 'closed',
      },
    ]);
    const featureContent = [
      'Feature: Sample',
      '@ac-1',
      'Scenario: first',
      '  Given x',
      '',
      '@ac-2',
      'Scenario: second',
      '  Given y',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 7002,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: { agentSettings: {}, orchestration: {} },
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
        body: '## Planning Artifacts\n- [x] Acceptance Spec: #7501\n',
      },
      {
        id: 7501,
        labels: ['context::acceptance-spec'],
        body: '| AC-1 | a |\n| AC-2 | b |\n| AC-3 | c |\n',
        state: 'closed',
      },
    ]);
    const featureContent = [
      'Feature: Sample',
      '@ac-1',
      'Scenario: only one',
      '  Given x',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 7003,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: { agentSettings: {}, orchestration: {} },
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
        body: '## Planning Artifacts\n- [x] Acceptance Spec: #7502\n',
      },
      {
        id: 7502,
        labels: ['context::acceptance-spec'],
        body: '| AC-1 | a |\n| AC-2 | b |\n',
        state: 'closed',
      },
    ]);
    const featureContent = [
      'Feature: Sample',
      '@ac-1',
      'Scenario: first',
      '  Given x',
      '',
      '@ac-2 @pending',
      'Scenario: pending one',
      '  Given y',
    ].join('\n');
    const out = await reconcileAcceptanceSpec({
      epicId: 7004,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: { agentSettings: {}, orchestration: {} },
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => ['/fake/a.feature'],
      readFeatureFile: () => featureContent,
    });
    assert.equal(out.ok, false);
    assert.deepEqual(out.satisfied, ['AC-1']);
    assert.deepEqual(out.pending, ['AC-2']);
    assert.deepEqual(out.missing, []);
  });

  it('returns status=empty-spec when the spec has no AC IDs', async () => {
    const provider = buildProvider([
      {
        id: 7005,
        labels: ['type::epic'],
        body: '## Planning Artifacts\n- [x] Acceptance Spec: #7503\n',
      },
      {
        id: 7503,
        labels: ['context::acceptance-spec'],
        body: 'no AC table here',
        state: 'closed',
      },
    ]);
    const out = await reconcileAcceptanceSpec({
      epicId: 7005,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: { agentSettings: {}, orchestration: {} },
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => [],
    });
    assert.equal(out.status, 'empty-spec');
    assert.equal(out.ok, true);
  });

  it('honours pre-populated linkedIssues.acceptanceSpec on the epic', async () => {
    const provider = buildProvider([
      {
        id: 7006,
        labels: ['type::epic'],
        body: '', // empty — body parser would say "no spec"
        linkedIssues: { prd: null, techSpec: null, acceptanceSpec: 7600 },
      },
      {
        id: 7600,
        labels: ['context::acceptance-spec'],
        body: '| AC-1 | x |\n',
        state: 'closed',
      },
    ]);
    const out = await reconcileAcceptanceSpec({
      epicId: 7006,
      cwd: process.cwd(),
      injectedProvider: provider,
      injectedConfig: { agentSettings: {}, orchestration: {} },
      loggerImpl: SILENT_LOGGER,
      listFeatureFiles: () => [],
    });
    assert.equal(out.acceptanceSpecId, 7600);
    assert.deepEqual(out.missing, ['AC-1']);
    assert.equal(out.ok, false);
  });
});
