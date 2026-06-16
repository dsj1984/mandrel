/**
 * tests/audit-suite/epic-audit-prepare.test.js
 *
 * Contract test for Story #2603 / Task #2608: pin the JSON envelope
 * shape that `helpers/epic-audit.md` reads from
 * `.agents/scripts/epic-audit-prepare.js`. The CLI is thin glue around
 * the audit-suite `selectAudits` SDK; this test exercises the envelope
 * via the exported `runEpicAuditPrepare` orchestrator with a seeded
 * provider + fake `selectAudits` injection so the test is hermetic.
 *
 * Two input cases are pinned per the Story's acceptance criteria:
 *   - `lenses-selected`        — a change set whose files + ticket
 *     copy select at least one lens (Epic-mode happy path).
 *   - `zero-lenses-selected`   — a docs-only change set with no
 *     keyword overlap; selector returns `selectedAudits: []` and the
 *     envelope must still render with the canonical shape (empty
 *     arrays, count 0, empty substitutionsPayload).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseArgv,
  runEpicAuditPrepare,
} from '../../.agents/scripts/epic-audit-prepare.js';
import { MockProvider } from '../fixtures/mock-provider.js';

const EPIC_ID = 2586;

function makeProvider() {
  return new MockProvider({
    tickets: {
      [EPIC_ID]: {
        id: EPIC_ID,
        title: 'Smart change-set audits at Epic finalize',
        body: 'Wire selectAudits into a new Phase 4 helper.',
        labels: ['type::epic'],
      },
    },
  });
}

/**
 * Build a fake `selectAudits` runner that returns the canonical
 * success envelope shape from `lib/audit-suite/selector.js` without
 * touching the filesystem or git.
 */
function makeFakeSelectAudits({ selectedAudits, changedFiles, ticketTitle }) {
  // Mirror the real selector: echo the `headRef` it was pinned to back as
  // `context.resolvedRef`, so epic-audit-prepare's per-epic ref assertion
  // (Story #3362) sees the same value it requested.
  return async ({ ticketId, gate, headRef }) => ({
    selectedAudits,
    ticketId,
    gate,
    context: {
      changedFiles,
      changedFilesCount: changedFiles.length,
      resolvedRef: headRef,
      ticketTitle,
    },
  });
}

const noopConfig = () => ({});
const noopProviderFactory = (provider) => () => provider;

/**
 * Fake `readPlanState` that returns a checkpoint whose `planningRisk`
 * envelope carries the supplied axes — the model-judged risk verdict the
 * delivery path routes audit lenses from (Story #3889).
 */
function makeFakeReadPlanState(planningRisk) {
  return async () => (planningRisk === null ? null : { planningRisk });
}

test('parseArgv: accepts --epic and defaults base-branch to main + gate to gate3', () => {
  const v = parseArgv(['--epic', '2586']);
  assert.equal(v.epicId, 2586);
  assert.equal(v.baseBranch, 'main');
  assert.equal(v.gate, 'gate3');
});

test('parseArgv: --help is a boolean flag', () => {
  const v = parseArgv(['--help']);
  assert.equal(v.help, true);
});

test('runEpicAuditPrepare: lenses-selected — envelope carries selected lenses + scoped changedFiles', async () => {
  const provider = makeProvider();
  const changedFiles = ['src/auth/login.js', 'src/api/admin/users.ts'];
  const selectedAudits = ['audit-security', 'audit-privacy'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits,
        changedFiles,
        ticketTitle: 'Smart change-set audits at Epic finalize',
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'envelope');
  assert.equal(result.envelope.epicId, EPIC_ID);
  assert.equal(result.envelope.epicBranch, `epic/${EPIC_ID}`);
  assert.deepEqual(result.envelope.selectedAudits, selectedAudits);
  assert.deepEqual(result.envelope.changedFiles, changedFiles);
  assert.equal(result.envelope.changedFilesCount, changedFiles.length);
  assert.equal(
    result.envelope.substitutionsPayload,
    changedFiles.join('\n'),
    'substitutionsPayload must be the newline-joined changedFiles list',
  );
});

test('runEpicAuditPrepare: zero-lenses-selected (docs-only) — envelope renders with empty arrays', async () => {
  const provider = makeProvider();

  // Docs-only diff: file list is populated but the selector decided
  // none of the lenses fire (no keyword match, no filePatterns hit).
  const changedFiles = ['docs/CHANGELOG.md', 'README.md'];
  const selectedAudits = [];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits,
        changedFiles,
        ticketTitle: 'Smart change-set audits at Epic finalize',
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.envelope.selectedAudits, []);
  assert.deepEqual(result.envelope.changedFiles, changedFiles);
  assert.equal(result.envelope.changedFilesCount, 2);
  assert.equal(result.envelope.substitutionsPayload, changedFiles.join('\n'));
});

test('runEpicAuditPrepare: missing --epic returns validation-error with exit code 2', async () => {
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: null, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(makeProvider()),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: [],
        changedFiles: [],
        ticketTitle: '',
      }),
    },
  );

  assert.equal(exitCode, 2);
  assert.equal(result.kind, 'validation-error');
  assert.match(result.message, /--epic/);
});

test('runEpicAuditPrepare: degraded selectAudits envelope propagates with non-zero exit', async () => {
  const provider = makeProvider();

  const degradedRunner = async () => ({
    ok: false,
    degraded: true,
    reason: 'GIT_DIFF_TIMEOUT',
    detail: 'select-audits: git diff against main timed out',
  });

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: degradedRunner,
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(result.kind, 'envelope');
  assert.equal(result.envelope.degraded, true);
  assert.equal(result.envelope.reason, 'GIT_DIFF_TIMEOUT');
  assert.equal(result.envelope.epicId, EPIC_ID);
  assert.equal(result.envelope.epicBranch, `epic/${EPIC_ID}`);
});

test('runEpicAuditPrepare: pins selectAudits to the requested Epic branch ref (Story #3362)', async () => {
  const provider = makeProvider();
  let capturedArgs = null;

  const capturingRunner = async (args) => {
    capturedArgs = args;
    return {
      selectedAudits: ['audit-security'],
      ticketId: args.ticketId,
      gate: args.gate,
      context: {
        changedFiles: ['src/a.ts'],
        changedFilesCount: 1,
        resolvedRef: args.headRef,
        ticketTitle: 'x',
      },
    };
  };

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: capturingRunner,
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'envelope');
  // The selector must be pinned to refs/heads/epic/<id>, NOT the shared
  // checkout's HEAD — that is the whole point of the cross-epic isolation fix.
  assert.equal(capturedArgs.headRef, `refs/heads/epic/${EPIC_ID}`);
  assert.deepEqual(result.envelope.changedFiles, ['src/a.ts']);
});

test('runEpicAuditPrepare: degrades when selector resolves a different ref than requested (Story #3362)', async () => {
  const provider = makeProvider();

  // Selector reports it diffed a DIFFERENT epic's branch — exactly the
  // cross-epic leak symptom. Prepare must fail closed rather than emit the
  // wrong audit selection.
  const mismatchedRunner = async ({ ticketId, gate }) => ({
    selectedAudits: ['audit-seo'],
    ticketId,
    gate,
    context: {
      changedFiles: ['robots.txt', 'Schema.astro'],
      changedFilesCount: 2,
      resolvedRef: 'refs/heads/epic/9999',
      ticketTitle: 'x',
    },
  });

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: mismatchedRunner,
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(result.kind, 'envelope');
  assert.equal(result.envelope.degraded, true);
  assert.equal(result.envelope.reason, 'EPIC_REF_MISMATCH');
  assert.equal(result.envelope.epicId, EPIC_ID);
  assert.equal(result.envelope.epicBranch, `epic/${EPIC_ID}`);
});

// --- Story #3889: risk-routed audit lenses in the live delivery path -------

test('runEpicAuditPrepare: a high-risk security envelope routes audit-security into selectedAudits', async () => {
  const provider = makeProvider();
  // The change-set selector picks NOTHING (a docs-only-ish diff), proving the
  // audit-security lens fires purely from the model-judged risk verdict, not
  // from the change-set selection — the half of the rigor-routing capability
  // this Story wires into the live path.
  const changedFiles = ['docs/CHANGELOG.md'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: [],
        changedFiles,
        ticketTitle: 'x',
      }),
      // Real resolveAuditLenses runs (not injected) — only the checkpoint read
      // is faked, so this proves the genuine axis→lens wiring end-to-end.
      readPlanState: makeFakeReadPlanState({
        overallLevel: 'high',
        axes: [{ axis: 'security', level: 'high', rationale: 'auth boundary' }],
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.envelope.changeSetAudits, []);
  assert.deepEqual(result.envelope.riskRoutedAudits, ['audit-security']);
  assert.deepEqual(result.envelope.selectedAudits, ['audit-security']);
});

test('runEpicAuditPrepare: risk-routed lenses union with change-set lenses, de-duplicated', async () => {
  const provider = makeProvider();
  const changedFiles = ['src/auth/login.js'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        // Change set already selects audit-security + audit-privacy.
        selectedAudits: ['audit-security', 'audit-privacy'],
        changedFiles,
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState({
        overallLevel: 'high',
        axes: [
          { axis: 'security', level: 'high', rationale: 'auth' },
          { axis: 'public-api', level: 'high', rationale: 'breaking api' },
        ],
      }),
    },
  );

  assert.equal(exitCode, 0);
  // audit-security is in both sources — it must appear once. audit-architecture
  // is risk-only and appended after the change-set selection.
  assert.deepEqual(result.envelope.changeSetAudits, [
    'audit-security',
    'audit-privacy',
  ]);
  assert.deepEqual(result.envelope.riskRoutedAudits, [
    'audit-security',
    'audit-architecture',
  ]);
  assert.deepEqual(result.envelope.selectedAudits, [
    'audit-security',
    'audit-privacy',
    'audit-architecture',
  ]);
});

test('runEpicAuditPrepare: a low-risk envelope routes no extra lenses (change-set only)', async () => {
  const provider = makeProvider();
  const changedFiles = ['src/util/format.js'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-clean-code'],
        changedFiles,
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState({
        overallLevel: 'low',
        axes: [{ axis: 'internal-refactor', level: 'low', rationale: 'tidy' }],
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(result.envelope.riskRoutedAudits, []);
  assert.deepEqual(result.envelope.selectedAudits, ['audit-clean-code']);
});

test('runEpicAuditPrepare: a missing checkpoint degrades to change-set selection (no abort)', async () => {
  const provider = makeProvider();
  const changedFiles = ['src/auth/login.js'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-security'],
        changedFiles,
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState(null),
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(result.envelope.riskRoutedAudits, []);
  assert.deepEqual(result.envelope.selectedAudits, ['audit-security']);
});

test('runEpicAuditPrepare: a checkpoint-read failure degrades to change-set selection', async () => {
  const provider = makeProvider();
  const changedFiles = ['src/auth/login.js'];

  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-privacy'],
        changedFiles,
        ticketTitle: 'x',
      }),
      readPlanState: async () => {
        throw new Error('provider blew up reading the checkpoint');
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(result.envelope.riskRoutedAudits, []);
  assert.deepEqual(result.envelope.selectedAudits, ['audit-privacy']);
});

test('runEpicAuditPrepare: --help yields help payload with exit 0', async () => {
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, help: true },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(makeProvider()),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: [],
        changedFiles: [],
        ticketTitle: '',
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.kind, 'help');
  assert.match(result.text, /--epic/);
});

test('runEpicAuditPrepare: --help documents the depth field (Story #3939)', async () => {
  const { result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, help: true },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(makeProvider()),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: [],
        changedFiles: [],
        ticketTitle: '',
      }),
    },
  );
  assert.equal(result.kind, 'help');
  assert.match(result.text, /depth/);
  assert.match(result.text, /light \| standard \| deep/);
});

// --- Story #3939: depth-aware audit envelope -------------------------------
//
// The default sizing thresholds (DEFAULT_TASK_SIZING) are softFiles=15,
// hardFiles=30. With the default config (noopConfig → no taskSizing override),
// `resolveDepth` resolves:
//   - high risk (any width)                → deep
//   - low risk + count ≤ 15                 → light
//   - absent checkpoint + small/unknown     → standard
//   - low risk + count > 30 (wide)          → deep (width escalation)

/** Build an N-element changed-file list so a test can drive the diff width. */
function makeChangedFiles(n) {
  return Array.from({ length: n }, (_, i) => `src/mod/file-${i}.js`);
}

test('runEpicAuditPrepare: high-risk envelope resolves depth=deep', async () => {
  const provider = makeProvider();
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-clean-code'],
        changedFiles: ['src/auth/login.js', 'src/auth/session.js'],
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState({
        overallLevel: 'high',
        axes: [{ axis: 'security', level: 'high', rationale: 'auth' }],
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.envelope.depth, 'deep');
});

test('runEpicAuditPrepare: low-risk + small change set resolves depth=light', async () => {
  const provider = makeProvider();
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-clean-code'],
        // 3 files ≤ softFiles(15) → small.
        changedFiles: makeChangedFiles(3),
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState({
        overallLevel: 'low',
        axes: [{ axis: 'internal-refactor', level: 'low', rationale: 'tidy' }],
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.envelope.depth, 'light');
});

test('runEpicAuditPrepare: low-risk but wide change set escalates depth to deep', async () => {
  const provider = makeProvider();
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-clean-code'],
        // 40 files > hardFiles(30) → wide; width escalates a low-risk Epic.
        changedFiles: makeChangedFiles(40),
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState({
        overallLevel: 'low',
        axes: [{ axis: 'internal-refactor', level: 'low', rationale: 'tidy' }],
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.envelope.depth, 'deep');
});

test('runEpicAuditPrepare: absent checkpoint resolves depth=standard', async () => {
  const provider = makeProvider();
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        // A mid-width diff (between soft and hard) with no risk verdict must
        // land on the neutral middle, never light.
        selectedAudits: ['audit-clean-code'],
        changedFiles: makeChangedFiles(12),
        ticketTitle: 'x',
      }),
      readPlanState: makeFakeReadPlanState(null),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(result.envelope.depth, 'standard');
});

test('runEpicAuditPrepare: a checkpoint-read failure degrades depth to width-only (standard)', async () => {
  const provider = makeProvider();
  const { exitCode, result } = await runEpicAuditPrepare(
    { epicId: EPIC_ID, baseBranch: 'main', gate: 'gate3' },
    {
      resolveConfig: noopConfig,
      createProvider: noopProviderFactory(provider),
      selectAudits: makeFakeSelectAudits({
        selectedAudits: ['audit-clean-code'],
        changedFiles: makeChangedFiles(5),
        ticketTitle: 'x',
      }),
      readPlanState: async () => {
        throw new Error('provider blew up reading the checkpoint');
      },
    },
  );

  // No risk signal + a small/known width → standard (light requires a
  // low-risk judgment, which a read failure cannot supply).
  assert.equal(exitCode, 0);
  assert.equal(result.envelope.depth, 'standard');
});
