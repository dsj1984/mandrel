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
