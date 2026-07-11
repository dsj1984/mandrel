/**
 * tests/audit-suite/epic-close-slim.test.js
 *
 * Capstone contract for Epic #4405 / Story #4412 — the slim Epic-close
 * (gate3) lens tier. Pins:
 *
 *   1. `selectEpicCloseLenses` restricts a prepared gate3 roster to the
 *      cumulative + global + risk-routed lenses only, excluding every
 *      local-tier change-set lens (routed off `resolveLensTier`). A fixture
 *      change set that would today select a local lens at gate3 selects none
 *      of them after the tier filter.
 *   2. `epic-audit-prepare.js` surfaces the slim roster on `epicCloseLenses`.
 *   3. `delivery.epicAudit.autoFixSeverity` resolves to `high` by default via
 *      `config/runners.js`, and the runtime AJV schema round-trips a configured
 *      value while rejecting a bad one.
 *   4. No `audit-results` structured-comment marker producer remains under
 *      `.agents/` — the Phase 4 producer was retired and the walk folded into
 *      the Phase 5 `verification-results` pass.
 *
 * Tier: contract — pure selection semantics, the prepare envelope wire shape,
 * config-default + schema round-trip, and a repository-invariant grep.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runEpicAuditPrepare } from '../../.agents/scripts/epic-audit-prepare.js';
import { getRunners } from '../../.agents/scripts/lib/config/runners.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';
import { selectEpicCloseLenses } from '../../.agents/scripts/lib/orchestration/code-review.js';
import { MockProvider } from '../fixtures/mock-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// A hermetic tier resolver so the pure-function tests never touch disk.
const FAKE_TIERS = {
  'audit-clean-code': 'local',
  'audit-security': 'local',
  'audit-privacy': 'local',
  'audit-architecture': 'cumulative',
  'audit-dependencies': 'cumulative',
  'audit-navigability': 'global',
  'audit-sre': 'global',
};
const fakeResolveLensTier = (lens) => {
  const tier = FAKE_TIERS[lens];
  if (!tier) throw new Error(`unknown lens '${lens}'`);
  return tier;
};

test('selectEpicCloseLenses: drops local-tier change-set lenses, keeps cumulative + global', () => {
  const roster = selectEpicCloseLenses({
    changeSetAudits: [
      'audit-clean-code', // local  → dropped
      'audit-architecture', // cumulative → kept
      'audit-privacy', // local  → dropped
      'audit-navigability', // global → kept
    ],
    riskRoutedAudits: [],
    resolveLensTierFn: fakeResolveLensTier,
  });
  assert.deepEqual(roster, ['audit-architecture', 'audit-navigability']);
});

test('selectEpicCloseLenses: a change set selecting only local lenses yields an empty roster', () => {
  // The acceptance fixture: a gate3 selection that today runs local lenses
  // selects none of them at Epic close once the tier filter applies.
  const roster = selectEpicCloseLenses({
    changeSetAudits: ['audit-clean-code', 'audit-security', 'audit-privacy'],
    riskRoutedAudits: [],
    resolveLensTierFn: fakeResolveLensTier,
  });
  assert.deepEqual(roster, []);
});

test('selectEpicCloseLenses: risk-routed lenses are kept regardless of tier', () => {
  // audit-security is local-tier, but a high-risk axis routed it — it must
  // still run at Epic close.
  const roster = selectEpicCloseLenses({
    changeSetAudits: ['audit-clean-code'], // local → dropped
    riskRoutedAudits: ['audit-security'], // local but risk-routed → kept
    resolveLensTierFn: fakeResolveLensTier,
  });
  assert.deepEqual(roster, ['audit-security']);
});

test('selectEpicCloseLenses: de-duplicates and preserves order (kept change-set first, then risk-routed)', () => {
  const roster = selectEpicCloseLenses({
    changeSetAudits: ['audit-architecture', 'audit-privacy'],
    // audit-architecture also risk-routed (dedup), audit-security new.
    riskRoutedAudits: ['audit-architecture', 'audit-security'],
    resolveLensTierFn: fakeResolveLensTier,
  });
  assert.deepEqual(roster, ['audit-architecture', 'audit-security']);
});

test('selectEpicCloseLenses: empty inputs and defaults are total', () => {
  assert.deepEqual(
    selectEpicCloseLenses({ resolveLensTierFn: fakeResolveLensTier }),
    [],
  );
  assert.deepEqual(
    selectEpicCloseLenses({
      changeSetAudits: [],
      riskRoutedAudits: [],
      resolveLensTierFn: fakeResolveLensTier,
    }),
    [],
  );
});

test('selectEpicCloseLenses: routes off the REAL audit-rules tiers by default', () => {
  // No injected resolver — reads audit-rules.json from disk. audit-clean-code
  // is local (dropped), audit-architecture is cumulative (kept).
  const roster = selectEpicCloseLenses({
    changeSetAudits: ['audit-clean-code', 'audit-architecture'],
    riskRoutedAudits: [],
  });
  assert.deepEqual(roster, ['audit-architecture']);
});

test('epic-audit-prepare: surfaces the slim roster on epicCloseLenses (local change-set lens excluded)', async () => {
  const EPIC_ID = 4405;
  const provider = new MockProvider({
    tickets: {
      [EPIC_ID]: {
        id: EPIC_ID,
        title: 'Shift-left audit tiers',
        body: 'Slim the Epic-close roster.',
        labels: ['type::epic'],
      },
    },
  });
  const changedFiles = ['.agents/scripts/foo.js'];
  // Change set selects a local lens (audit-clean-code) plus a cumulative one
  // (audit-architecture); no risk routing.
  const fakeSelectAudits = async ({ ticketId, gate, headRef }) => ({
    selectedAudits: ['audit-clean-code', 'audit-architecture'],
    ticketId,
    gate,
    context: {
      changedFiles,
      changedFilesCount: changedFiles.length,
      resolvedRef: headRef,
      ticketTitle: 'Shift-left audit tiers',
    },
  });

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: () => ({}),
      createProvider: () => provider,
      selectAudits: fakeSelectAudits,
      // No epic-plan-state checkpoint → no risk-routed lenses.
      readPlanState: async () => null,
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'envelope');
  // The pre-slim union still lists both lenses for observability.
  assert.deepEqual(result.envelope.selectedAudits, [
    'audit-clean-code',
    'audit-architecture',
  ]);
  // The slim Epic-close roster drops the local lens.
  assert.deepEqual(result.envelope.epicCloseLenses, ['audit-architecture']);
});

test('runners: delivery.epicAudit.autoFixSeverity defaults to high; codeReview stays medium', () => {
  const r = getRunners({});
  assert.equal(r.epicAudit.autoFixSeverity, 'high');
  assert.equal(r.codeReview.autoFixSeverity, 'medium');
});

test('runners: an explicit delivery.epicAudit.autoFixSeverity override wins', () => {
  const r = getRunners({
    delivery: { epicAudit: { autoFixSeverity: 'medium' } },
  });
  assert.equal(r.epicAudit.autoFixSeverity, 'medium');
});

test('AJV schema: a configured epicAudit.autoFixSeverity round-trips; a bad value is rejected', () => {
  const validate = getAgentrcValidator();
  const base = {
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
  };
  // Round-trip: high validates.
  assert.equal(
    validate({
      ...base,
      delivery: { epicAudit: { autoFixSeverity: 'high' } },
    }),
    true,
    'epicAudit.autoFixSeverity: high must validate',
  );
  // Reject: an out-of-enum value fails validation.
  assert.equal(
    validate({
      ...base,
      delivery: { epicAudit: { autoFixSeverity: 'low' } },
    }),
    false,
    'epicAudit.autoFixSeverity: low must be rejected',
  );
});

test('no audit-results structured-comment marker producer remains under .agents/', () => {
  // The Epic-close lens walk folded into the Phase 5 verification-results pass
  // (Story #4412). Assert the retired producer patterns are gone: the
  // `--marker audit-results` CLI flag, and any JS that emits an
  // `audit-results` structured comment via structuredCommentMarker/upsert.
  // The graduator's follow-up dedup markers (`audit-results-followup`), its
  // `graduator: 'audit-results'` attr, and the `audit-results::<sev>` labels
  // are NOT structured-comment producers and are intentionally out of scope.
  const search = (pattern) => {
    try {
      return execFileSync(
        'grep',
        ['-rIl', '--include=*.md', '--include=*.js', pattern, '.agents'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
    } catch (err) {
      // grep exits 1 with no matches — that is the passing case.
      if (err.status === 1) return [];
      throw err;
    }
  };

  assert.deepEqual(
    search('marker audit-results'),
    [],
    'no `--marker audit-results` producer flag may remain',
  );
  assert.deepEqual(
    search("structuredCommentMarker('audit-results')"),
    [],
    'no JS may emit an audit-results structured-comment marker',
  );
  // The unified marker IS present (the fold target), proving the producer moved
  // rather than vanished.
  assert.ok(
    search("'verification-results'").length > 0,
    'the unified verification-results marker producer must exist',
  );
});
