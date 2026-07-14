/**
 * tests/epic-audit-prepare-navigability.test.js
 *
 * Epic #4131 (F2/F3) — the navigability audit lens.
 *
 * Pins three behaviours of the deliberately-global navigability lens, all
 * exercised through the exported `runEpicAuditPrepare` orchestrator and the
 * pure selector helpers, with a seeded MockProvider + fake `selectAudits`
 * injection so the suite is hermetic (no git, no filesystem):
 *
 *   1. ROUTE-ADDED ROUTING (AC-4) — when a changed file matches a configured
 *      route glob, the navigability lens is selected through the EXISTING
 *      risk-routed-lens union (`unionAudits`), with no new routing function.
 *   2. LEAK-GUARD EXEMPTION (AC-3) — the navigability lens is on the
 *      global-lens allowlist and is surfaced in `globalLenses` (the helper's
 *      signal to run it whole-route-tree, exempt from the cross-epic-leak
 *      guard `#3362`), while every other lens stays scoped to the change set.
 *   3. UNCONFIGURED NO-OP (AC-13) — with no navigability config present, lens
 *      selection is unchanged: the lens is neither routed nor flagged global.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { runEpicAuditPrepare } from '../.agents/scripts/epic-audit-prepare.js';
import {
  GLOBAL_LENS_ALLOWLIST,
  isGlobalLens,
  NAVIGABILITY_LENS,
  resolveNavigabilityRouteGlobs,
  routesNavigabilityLens,
} from '../.agents/scripts/lib/audit-suite/index.js';
import { MockProvider } from './fixtures/mock-provider.js';

const EPIC_ID = 4131;

function makeProvider() {
  return new MockProvider({
    tickets: {
      [EPIC_ID]: {
        id: EPIC_ID,
        title: 'Navigability audit lens',
        body: 'Whole route tree + nav registry evaluation.',
        labels: ['type::story'],
      },
    },
  });
}

/**
 * Fake `selectAudits` runner returning the canonical success envelope shape
 * from `lib/audit-suite/selector.js` without touching git/fs. Echoes the
 * pinned `headRef` back as `context.resolvedRef` so the prepare CLI's per-epic
 * ref assertion (Story #3362) sees what it requested.
 */
function makeFakeSelectAudits({ selectedAudits, changedFiles }) {
  return async ({ ticketId, gate, headRef }) => ({
    selectedAudits,
    ticketId,
    gate,
    context: {
      changedFiles,
      changedFilesCount: changedFiles.length,
      resolvedRef: headRef,
      ticketTitle: 'Navigability audit lens',
    },
  });
}

/** A resolved-config wrapper carrying navigability route globs. */
const navConfig = (routeGlobs) => () => ({
  delivery: { quality: { navigability: { routeGlobs } } },
});

const noopProviderFactory = (provider) => () => provider;

/** No risk verdict on the checkpoint — isolates the navigability routing. */
const noRiskCheckpoint = async () => null;

// --- selector-level unit checks --------------------------------------------

test('NAVIGABILITY_LENS is on the global-lens allowlist', () => {
  assert.ok(GLOBAL_LENS_ALLOWLIST.includes(NAVIGABILITY_LENS));
  assert.equal(isGlobalLens(NAVIGABILITY_LENS), true);
});

test('isGlobalLens: a change-set-scoped lens is NOT global (guard intact)', () => {
  assert.equal(isGlobalLens('audit-security'), false);
  assert.equal(isGlobalLens('audit-privacy'), false);
  assert.equal(isGlobalLens('audit-ux-ui'), false);
});

test('resolveNavigabilityRouteGlobs: absent config resolves to []', () => {
  assert.deepEqual(resolveNavigabilityRouteGlobs(undefined), []);
  assert.deepEqual(resolveNavigabilityRouteGlobs({}), []);
  assert.deepEqual(resolveNavigabilityRouteGlobs({ delivery: {} }), []);
});

test('routesNavigabilityLens: matching route glob routes the lens', () => {
  const config = {
    delivery: {
      quality: { navigability: { routeGlobs: ['app/**/route.ts'] } },
    },
  };
  assert.equal(
    routesNavigabilityLens({ changedFiles: ['app/admin/route.ts'], config }),
    true,
  );
});

test('routesNavigabilityLens: no config → false (unconfigured no-op)', () => {
  assert.equal(
    routesNavigabilityLens({
      changedFiles: ['app/admin/route.ts'],
      config: {},
    }),
    false,
  );
});

// --- AC-4: route-added routing via the existing risk-routed-lens union ------

test('runEpicAuditPrepare: a changed file under a route glob routes the navigability lens via the union', async () => {
  const provider = makeProvider();
  // The change-set selector picks NOTHING — proving the navigability lens
  // fires purely from the route-glob predicate routed through the existing
  // `riskRoutedAudits` union, not from the change-set selection.
  const changedFiles = ['app/dashboard/route.ts'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: navConfig(['app/**/route.ts', 'pages/**']),
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({ selectedAudits: [], changedFiles }),
      readPlanState: noRiskCheckpoint,
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.envelope.changeSetAudits, []);
  // Routed through the SAME union the verdict-routed lenses use.
  assert.deepEqual(result.envelope.riskRoutedAudits, [NAVIGABILITY_LENS]);
  assert.deepEqual(result.envelope.selectedAudits, [NAVIGABILITY_LENS]);
});

test('runEpicAuditPrepare: navigability unions with change-set + verdict-routed lenses, de-duplicated', async () => {
  const provider = makeProvider();
  const changedFiles = ['pages/settings/index.tsx', 'src/auth/login.js'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: navConfig(['pages/**']),
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-security'],
        changedFiles,
      }),
      // Real resolveAuditLenses runs; only the checkpoint read is faked.
      readPlanState: async () => ({
        planningRisk: {
          overallLevel: 'high',
          axes: [{ axis: 'security', level: 'high', rationale: 'auth' }],
        },
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(result.envelope.changeSetAudits, ['audit-security']);
  // Verdict routes audit-security (already in the change set) + navigability
  // from the route glob; the union de-dupes audit-security to one entry.
  assert.deepEqual(result.envelope.riskRoutedAudits, [
    'audit-security',
    NAVIGABILITY_LENS,
  ]);
  assert.deepEqual(result.envelope.selectedAudits, [
    'audit-security',
    NAVIGABILITY_LENS,
  ]);
});

// --- AC-3: leak-guard exemption (global lens) -------------------------------

test('runEpicAuditPrepare: the routed navigability lens is flagged global (leak-guard-exempt)', async () => {
  const provider = makeProvider();
  const changedFiles = ['pages/reports/[id].tsx'];

  const { result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: navConfig(['pages/**']),
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-security'],
        changedFiles,
      }),
      readPlanState: noRiskCheckpoint,
    },
  );

  // The navigability lens is exempt from the cross-epic-leak guard...
  assert.deepEqual(result.envelope.globalLenses, [NAVIGABILITY_LENS]);
  // ...while every OTHER selected lens stays scoped to the change set: it is
  // selected but NOT on the global-lens allowlist, so the guard still applies.
  assert.ok(result.envelope.selectedAudits.includes('audit-security'));
  assert.ok(!result.envelope.globalLenses.includes('audit-security'));
});

// --- AC-13: unconfigured no-op ----------------------------------------------

test('runEpicAuditPrepare: with no navigability config, lens selection is unchanged (no-op)', async () => {
  const provider = makeProvider();
  // A file that WOULD match a route glob if one were configured — but no
  // navigability config is present, so it must route nothing.
  const changedFiles = ['app/admin/route.ts'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      // noop config — no delivery.quality.navigability block.
      resolveConfig: () => ({}),
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-clean-code'],
        changedFiles,
      }),
      readPlanState: noRiskCheckpoint,
    },
  );

  assert.equal(exitCode, 0);
  // Navigability is neither routed nor flagged global — pure no-op.
  assert.deepEqual(result.envelope.riskRoutedAudits, []);
  assert.deepEqual(result.envelope.globalLenses, []);
  assert.deepEqual(result.envelope.selectedAudits, ['audit-clean-code']);
  assert.ok(!result.envelope.selectedAudits.includes(NAVIGABILITY_LENS));
});
