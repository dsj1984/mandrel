/**
 * tests/audit-suite/epic-audit-helper.test.js
 *
 * Contract test for Story #2607 / Task #2612: pin the end-to-end dispatch
 * shape that `.agents/workflows/helpers/epic-audit.md` relies on.
 *
 * The helper consumes a `selectAudits` envelope from
 * `epic-audit-prepare.js`, then walks each selected lens via
 * `runAuditSuite`, and finally posts an `audit-results` structured
 * comment. This test exercises the two helper-side branches end-to-end:
 *
 *   1. **lenses applied** — a non-empty `selectedAudits` roster from
 *      prepare flows into `runAuditSuite`, the runner returns a
 *      success envelope with the requested lenses in
 *      `metadata.auditsRun`, and the resulting comment body carries
 *      the canonical `audit-results` marker line.
 *
 *   2. **no lenses selected (docs-only)** — an empty `selectedAudits`
 *      list from prepare still produces a renderable envelope with
 *      `auditsRun: []` and a docs-only marker note in the comment body.
 *
 * The test is hermetic: it injects a fake `selectAudits` runner into
 * `runEpicAuditPrepare` and a fake workflow loader + write-artifact sink
 * into `runAuditSuite`. No filesystem, git, or network I/O fires.
 *
 * Tier: contract — exercises the wire shape between the helper's two
 * SDK boundaries (prepare envelope → runAuditSuite envelope → comment
 * body). Per `.agents/rules/testing-standards.md`, status-code and
 * envelope-shape assertions belong here, not in unit or feature tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runEpicAuditPrepare } from '../../.agents/scripts/epic-audit-prepare.js';
import { runAuditSuite } from '../../.agents/scripts/lib/audit-suite/index.js';
import { MockProvider } from '../fixtures/mock-provider.js';

const EPIC_ID = 2586;
const AUDIT_RESULTS_MARKER = '<!-- claude-managed: audit-results -->';

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

const noopConfig = () => ({ orchestration: {} });
const noopProviderFactory = (provider) => () => provider;

function makeFakeSelectAudits({ selectedAudits, changedFiles, ticketTitle }) {
  return async ({ ticketId, gate }) => ({
    selectedAudits,
    ticketId,
    gate,
    context: {
      changedFiles,
      changedFilesCount: changedFiles.length,
      ticketTitle,
    },
  });
}

function makeFakeWorkflowLoader(registeredLenses) {
  return async (auditName) => {
    if (!registeredLenses.includes(auditName)) return null;
    return {
      path: `.agents/workflows/${auditName}.md`,
      content: `# ${auditName}\n\nChanged files:\n{{changedFiles}}\n\nTicket: {{ticketId}}\n`,
    };
  };
}

function makeFakeRulesFor(lenses) {
  const audits = {};
  for (const name of lenses) {
    audits[name] = {
      triggers: { gates: ['gate3'] },
      substitutionKeys: [],
    };
  }
  return { audits };
}

const fakeWriteArtifact = async (_dir, fileName, _content) => fileName;

function renderAuditResultsBody({ envelope, suiteEnvelope }) {
  const lensList =
    envelope.selectedAudits.length > 0
      ? envelope.selectedAudits.join(', ')
      : 'none (docs-only)';
  const lines = [
    AUDIT_RESULTS_MARKER,
    '',
    `### Epic #${envelope.epicId} — audit results`,
    '',
    `Lenses applied: ${lensList}`,
    `Lenses run: ${suiteEnvelope.metadata.auditsRun.join(', ') || '—'}`,
    `Files in scope: ${envelope.changedFilesCount}`,
    '',
    `Findings: ${suiteEnvelope.findings.length}`,
  ];
  return lines.join('\n');
}

test('helper dispatch: lenses applied → suite returns auditsRun and comment carries marker', async () => {
  // Arrange — prepare envelope says two lenses fire.
  const provider = makeProvider();
  const changedFiles = ['src/auth/login.js', 'src/api/admin/users.ts'];
  const selectedAudits = ['audit-security', 'audit-privacy'];

  const { exitCode: prepExit, result: prepResult } = await runEpicAuditPrepare(
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

  assert.equal(prepExit, 0);
  assert.equal(prepResult.kind, 'envelope');

  // Act — runAuditSuite walks the prepared lens roster hermetically.
  const suiteEnvelope = await runAuditSuite({
    auditWorkflows: prepResult.envelope.selectedAudits,
    substitutions: {
      ticketId: String(EPIC_ID),
      baseBranch: 'main',
      changedFiles: prepResult.envelope.substitutionsPayload,
    },
    artifactPrefix: `epic-${EPIC_ID}`,
    injectedLoadWorkflow: makeFakeWorkflowLoader(selectedAudits),
    injectedRules: makeFakeRulesFor(selectedAudits),
    injectedWriteArtifact: fakeWriteArtifact,
  });

  // Assert — the suite envelope reports both lenses ran, and a rendered
  // audit-results comment carries the canonical marker.
  assert.deepEqual(
    suiteEnvelope.metadata.auditsRequested,
    selectedAudits,
    'auditsRequested mirrors the prepared roster',
  );
  assert.deepEqual(
    [...suiteEnvelope.metadata.auditsRun].sort(),
    [...selectedAudits].sort(),
    'every requested lens ran',
  );
  assert.equal(
    suiteEnvelope.findings.length,
    0,
    'no error findings on happy path',
  );

  const commentBody = renderAuditResultsBody({
    envelope: prepResult.envelope,
    suiteEnvelope,
  });
  assert.ok(
    commentBody.startsWith(AUDIT_RESULTS_MARKER),
    'comment body opens with the audit-results structured marker',
  );
  assert.match(commentBody, /audit-security/);
  assert.match(commentBody, /audit-privacy/);
});

test('helper dispatch: no lenses selected (docs-only) → suite runs zero lenses and comment marks it', async () => {
  // Arrange — docs-only change set: selector returns empty.
  const provider = makeProvider();
  const changedFiles = ['docs/CHANGELOG.md', 'README.md'];
  const selectedAudits = [];

  const { exitCode: prepExit, result: prepResult } = await runEpicAuditPrepare(
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

  assert.equal(prepExit, 0);
  assert.deepEqual(prepResult.envelope.selectedAudits, []);

  // Act — invoking the suite with an empty roster is a contract path
  // the helper must support (Step 1 → Step 4 short-circuit).
  const suiteEnvelope = await runAuditSuite({
    auditWorkflows: prepResult.envelope.selectedAudits,
    substitutions: {
      ticketId: String(EPIC_ID),
      baseBranch: 'main',
      changedFiles: prepResult.envelope.substitutionsPayload,
    },
    injectedLoadWorkflow: makeFakeWorkflowLoader([]),
    injectedRules: makeFakeRulesFor([]),
    injectedWriteArtifact: fakeWriteArtifact,
  });

  // Assert — no lenses ran, no findings, and the rendered comment names
  // the docs-only path explicitly.
  assert.deepEqual(suiteEnvelope.metadata.auditsRequested, []);
  assert.deepEqual(suiteEnvelope.metadata.auditsRun, []);
  assert.equal(suiteEnvelope.findings.length, 0);

  const commentBody = renderAuditResultsBody({
    envelope: prepResult.envelope,
    suiteEnvelope,
  });
  assert.ok(commentBody.startsWith(AUDIT_RESULTS_MARKER));
  assert.match(
    commentBody,
    /Lenses applied: none \(docs-only\)/,
    'docs-only path is marked in the comment body',
  );
});
