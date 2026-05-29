import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatBranchProtectionSummary,
  formatMergeMethodsSummary,
  formatProjectSummary,
  formatWorkflowAuditSummary,
  printSummary,
} from '../../.agents/scripts/lib/bootstrap/summary.js';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

test('formatProjectSummary covers every state branch', () => {
  assert.equal(
    formatProjectSummary({ scopesMissing: true }),
    'skipped (missing project scope)',
  );
  assert.equal(
    formatProjectSummary({ created: true, projectNumber: 7 }),
    'created #7',
  );
  assert.equal(
    formatProjectSummary({ created: false, projectNumber: 12 }),
    'adopted #12',
  );
  assert.equal(formatProjectSummary({}), 'skipped');
});

test('formatBranchProtectionSummary covers every state branch', () => {
  assert.equal(formatBranchProtectionSummary(null), 'not-run');
  assert.equal(
    formatBranchProtectionSummary({
      status: 'created',
      added: ['lint', 'test'],
    }),
    'created (added: lint, test)',
  );
  assert.equal(
    formatBranchProtectionSummary({ status: 'merged', added: ['baselines'] }),
    'merged (added: baselines)',
  );
  assert.equal(
    formatBranchProtectionSummary({ status: 'merged', added: [] }),
    'merged (no changes)',
  );
  assert.equal(
    formatBranchProtectionSummary({ status: 'skipped', reason: 'no token' }),
    'skipped (no token)',
  );
  assert.equal(
    formatBranchProtectionSummary({ status: 'failed', reason: 'api 500' }),
    'failed (api 500)',
  );
  // Unknown status falls through to the raw status string.
  assert.equal(formatBranchProtectionSummary({ status: 'pending' }), 'pending');
});

test('formatWorkflowAuditSummary covers every state branch', () => {
  assert.equal(formatWorkflowAuditSummary(null), 'not-run');
  assert.equal(
    formatWorkflowAuditSummary({ skipped: true, reason: 'no .github' }),
    'skipped (no .github)',
  );
  assert.equal(
    formatWorkflowAuditSummary({ action: 'no-conflicts' }),
    'no conflicting workflows',
  );
  assert.equal(
    formatWorkflowAuditSummary({
      action: 'warn-only',
      audit: { conflicting: ['a.yml', 'b.yml'] },
    }),
    'warned (2 conflicting; pass --reap-conflicting-workflows to delete)',
  );
  assert.equal(
    formatWorkflowAuditSummary({ action: 'reaped', reaped: ['a.yml'] }),
    'reaped 1 workflow(s)',
  );
  // Unknown action falls through to the action string, then 'unknown'.
  assert.equal(formatWorkflowAuditSummary({ action: 'weird' }), 'weird');
  assert.equal(formatWorkflowAuditSummary({}), 'unknown');
});

test('formatMergeMethodsSummary covers every state branch', () => {
  assert.equal(formatMergeMethodsSummary(null), 'not-run');
  assert.equal(
    formatMergeMethodsSummary({ status: 'unchanged' }),
    'unchanged (already at target stance)',
  );
  assert.equal(
    formatMergeMethodsSummary({
      status: 'patched',
      patched: ['squash', 'merge'],
    }),
    'patched (squash, merge)',
  );
  // patched with an empty/missing list renders the em-dash placeholder.
  assert.equal(
    formatMergeMethodsSummary({ status: 'patched', patched: [] }),
    'patched (—)',
  );
  assert.equal(formatMergeMethodsSummary({ status: 'patched' }), 'patched (—)');
  assert.equal(
    formatMergeMethodsSummary({ status: 'skipped', reason: 'no perms' }),
    'skipped (no perms)',
  );
  assert.equal(
    formatMergeMethodsSummary({ status: 'failed', reason: 'graphql' }),
    'failed (graphql)',
  );
  assert.equal(formatMergeMethodsSummary({ status: 'odd' }), 'odd');
});

test('printSummary emits one info line per section via the injected Logger', (t) => {
  const lines = [];
  t.mock.method(Logger, 'info', (msg) => {
    lines.push(String(msg));
  });

  const result = {
    labels: { created: ['a', 'b'], skipped: ['c'] },
    fields: { created: [], skipped: ['x'] },
    project: { created: true, projectNumber: 9 },
    statusField: { status: 'created' },
    views: { created: ['v1'], skipped: [], unavailable: false },
    workflowAudit: { action: 'no-conflicts' },
    branchProtection: { status: 'merged', added: [] },
    mergeMethods: { status: 'unchanged' },
  };

  printSummary(result);

  const joined = lines.join('\n');
  assert.match(joined, /=== Bootstrap Summary ===/);
  assert.match(joined, /Labels created: 2/);
  assert.match(joined, /Project: created #9/);
  assert.match(joined, /Workflow audit: no conflicting workflows/);
  assert.match(joined, /Branch protection: merged \(no changes\)/);
  assert.match(joined, /Merge methods: unchanged \(already at target stance\)/);
});

test('printSummary surfaces the views mutation-unavailable suffix', (t) => {
  const lines = [];
  t.mock.method(Logger, 'info', (msg) => {
    lines.push(String(msg));
  });

  printSummary({
    labels: { created: [], skipped: [] },
    fields: { created: [], skipped: [] },
    project: {},
    statusField: { status: 'skipped' },
    views: { created: [], skipped: [], unavailable: true },
    workflowAudit: null,
    branchProtection: null,
    mergeMethods: null,
  });

  assert.match(
    lines.join('\n'),
    /Views — created: 0, skipped: 0 \(mutation unavailable\)/,
  );
});
