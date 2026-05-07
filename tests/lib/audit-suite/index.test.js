/**
 * tests/lib/audit-suite/index.test.js
 *
 * Pins the audit-suite SDK barrel introduced by Story #1083 / Epic #1072.
 * The barrel must re-export `runAuditSuite` and `selectAudits` (plus the
 * pure pattern-matching helpers) so the orchestration barrel can depend on
 * library-level modules instead of importing upward from top-level CLI
 * files.
 *
 * Behavioural parity with the existing `runAuditSuite` and `selectAudits`
 * test suites is covered there; these tests focus on the barrel surface.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesAnyFilePattern,
  matchesFilePattern,
  runAuditSuite,
  selectAudits,
} from '../../../.agents/scripts/lib/audit-suite/index.js';
import { __setGitRunners } from '../../../.agents/scripts/lib/git-utils.js';
import { MockProvider } from '../../fixtures/mock-provider.js';

test('lib/audit-suite barrel exports runAuditSuite and selectAudits', () => {
  assert.equal(typeof runAuditSuite, 'function');
  assert.equal(typeof selectAudits, 'function');
  assert.equal(typeof matchesFilePattern, 'function');
  assert.equal(typeof matchesAnyFilePattern, 'function');
});

test('lib/audit-suite: matchesFilePattern is the picomatch{dot:true} matcher', () => {
  // Pinned engine semantics — same suite the relocated `select-audits.js`
  // CLI tests pin from the back-compat shim path. If the engine swaps,
  // both surfaces must be updated together.
  assert.equal(matchesFilePattern('**/*.lock', 'yarn.lock'), true);
  assert.equal(matchesFilePattern('**.js', 'bundlejs'), false);
  assert.equal(matchesFilePattern('**/auth/*.js', 'src/auth/login.js'), true);
});

test('lib/audit-suite: matchesAnyFilePattern short-circuits on first match', () => {
  assert.equal(
    matchesAnyFilePattern(['*.ts', 'src/**/*.js'], ['src/lib/foo.js']),
    true,
  );
  assert.equal(matchesAnyFilePattern(['*.ts'], ['foo.js']), false);
  assert.equal(matchesAnyFilePattern([], ['foo.js']), false);
  assert.equal(matchesAnyFilePattern(['*.js'], []), false);
});

test('lib/audit-suite: runAuditSuite is callable through the barrel', async () => {
  // Smoke: the barrel export resolves to the same runner used by the CLI
  // and produces the documented envelope shape with no audit workflows.
  const result = await runAuditSuite({
    auditWorkflows: [],
    substitutions: {},
  });
  assert.ok(result.metadata, 'envelope must carry metadata');
  assert.deepEqual(result.metadata.auditsRequested, []);
  assert.deepEqual(result.metadata.auditsRun, []);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.workflows, []);
});

test('lib/audit-suite: selectAudits is callable through the barrel', async () => {
  const provider = new MockProvider({
    tickets: {
      900: {
        id: 900,
        title: 'Improve accessibility of modal dialogs',
        body: 'Screen-reader coverage missing.',
        labels: [],
      },
    },
  });

  __setGitRunners(
    () => '',
    () => ({ status: 0, stdout: '', stderr: '' }),
  );

  const result = await selectAudits({
    ticketId: 900,
    gate: 'gate2',
    provider,
  });

  assert.equal(result.ticketId, 900);
  assert.equal(result.gate, 'gate2');
  assert.ok(Array.isArray(result.selectedAudits));
  assert.equal(
    result.context.ticketTitle,
    'Improve accessibility of modal dialogs',
  );
});
