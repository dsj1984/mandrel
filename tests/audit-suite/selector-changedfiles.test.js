/**
 * tests/audit-suite/selector-changedfiles.test.js
 *
 * Contract test for Story #2597 / Task #2602: `selectAudits` must surface
 * the raw `changedFiles` array (not just the count) on its returned
 * `context` so downstream Epic-mode callers (e.g. `epic-audit`) can pass
 * the list through as the `{{changedFiles}}` substitution value.
 *
 * Invariant: `context.changedFilesCount === context.changedFiles.length`
 * — the existing count field is the cardinality of the new array, not an
 * independent computation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAudits } from '../../.agents/scripts/lib/audit-suite/selector.js';
import { MockProvider } from '../fixtures/mock-provider.js';

function makeProvider() {
  return new MockProvider({
    tickets: {
      500: {
        id: 500,
        title: 'Refactor billing module',
        body: 'Body intentionally devoid of keywords from audit-rules.json.',
        labels: [],
      },
    },
  });
}

test('selector: context.changedFiles is the full diff file list (not just a count)', async () => {
  const diffStdout = 'src/auth/login.js\nsrc/api/users.ts\n';
  const fakeGitSpawn = async () => ({
    status: 0,
    stdout: diffStdout,
    stderr: '',
  });

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.ok(
    Array.isArray(result.context.changedFiles),
    'context.changedFiles must be an array',
  );
  assert.deepEqual(result.context.changedFiles, [
    'src/auth/login.js',
    'src/api/users.ts',
  ]);
});

test('selector: context.changedFilesCount equals context.changedFiles.length', async () => {
  const diffStdout = 'a.js\nb.js\nc.js\n';
  const fakeGitSpawn = async () => ({
    status: 0,
    stdout: diffStdout,
    stderr: '',
  });

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.equal(result.context.changedFiles.length, 3);
  assert.equal(
    result.context.changedFilesCount,
    result.context.changedFiles.length,
    'count field must equal array length — they are the same cardinality',
  );
});

test('selector: empty diff yields empty changedFiles array (not undefined)', async () => {
  const fakeGitSpawn = async () => ({ status: 0, stdout: '', stderr: '' });

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.deepEqual(result.context.changedFiles, []);
  assert.equal(result.context.changedFilesCount, 0);
});
