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

test('selector: headRef pins the diff to the requested ref (Story #3362)', async () => {
  const epicRef = 'refs/heads/epic/1241';
  const seen = [];
  // Distinguish the rev-parse probe (resolves the ref) from the diff.
  const fakeGitSpawn = async (_cwd, ...args) => {
    seen.push(args);
    if (args[0] === 'rev-parse') {
      return { status: 0, stdout: 'abc123\n', stderr: '' };
    }
    // args: ['diff', '--name-only', '<base>...<headRef>']
    return { status: 0, stdout: 'env/doctor.js\nenv/fix.js\n', stderr: '' };
  };

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    headRef: epicRef,
    injectedGitSpawn: fakeGitSpawn,
  });

  // The diff range must terminate at the requested ref, not HEAD.
  const diffCall = seen.find((a) => a[0] === 'diff');
  assert.equal(diffCall[2], `main...${epicRef}`);
  assert.equal(result.context.resolvedRef, epicRef);
  assert.deepEqual(result.context.changedFiles, [
    'env/doctor.js',
    'env/fix.js',
  ]);
});

test('selector: unresolvable headRef returns a degraded envelope (Story #3362)', async () => {
  // rev-parse --verify --quiet returns non-zero + empty stdout when the ref
  // does not exist in this checkout — the concurrent-epic leak symptom.
  const fakeGitSpawn = async (_cwd, ...args) => {
    if (args[0] === 'rev-parse') {
      return { status: 1, stdout: '', stderr: '' };
    }
    throw new Error('diff should not run when the ref is unresolved');
  };

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    headRef: 'refs/heads/epic/9999',
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(result.reason, 'HEAD_REF_UNRESOLVED');
});

test('selector: default headRef (HEAD) skips the rev-parse probe and diffs HEAD', async () => {
  const seen = [];
  const fakeGitSpawn = async (_cwd, ...args) => {
    seen.push(args);
    return { status: 0, stdout: 'a.js\n', stderr: '' };
  };

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    injectedGitSpawn: fakeGitSpawn,
  });

  // No rev-parse probe for the default path; the diff terminates at HEAD.
  assert.ok(!seen.some((a) => a[0] === 'rev-parse'));
  const diffCall = seen.find((a) => a[0] === 'diff');
  assert.equal(diffCall[2], 'main...HEAD');
  assert.equal(result.context.resolvedRef, 'HEAD');
});

/**
 * Story #4571 — the injected-`changedFiles` seam.
 *
 * `selectAudits` derived its own change set from `git diff baseBranch...headRef`
 * in `process.cwd()`. The plan-run epilogue calls it from the main checkout
 * *after* the run's Stories have merged, so that range is empty by
 * construction — selection collapsed to keyword-matching the Story prose and
 * every file-pattern trigger was silently dead. Callers that already know the
 * change set pass it in; the internal diff is then not spawned at all.
 */

test('selector: injected changedFiles are used verbatim and no git diff is spawned', async () => {
  const seen = [];
  const fakeGitSpawn = async (_cwd, ...args) => {
    seen.push(args);
    return { status: 0, stdout: 'SHOULD-NOT-BE-READ.js\n', stderr: '' };
  };

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    changedFiles: ['src/auth/login.js', 'src/api/users.ts'],
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.equal(
    seen.length,
    0,
    'an injected change set must short-circuit the git diff entirely',
  );
  assert.deepEqual(result.context.changedFiles, [
    'src/auth/login.js',
    'src/api/users.ts',
  ]);
  assert.equal(
    result.context.changedFilesCount,
    result.context.changedFiles.length,
  );
});

test('selector: injected changedFiles drive file-pattern selection', async () => {
  // `audit-clean-code` declares no keywords — it is reachable ONLY via its
  // filePatterns. The provider's body is deliberately keyword-free, so a hit
  // here proves selection ran over the injected files.
  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate3',
    provider: makeProvider(),
    changedFiles: ['.agents/scripts/lib/orchestration/run-epilogue.js'],
    injectedGitSpawn: async () => {
      throw new Error('git must not be spawned on the injected path');
    },
  });

  assert.ok(
    result.selectedAudits.includes('audit-clean-code'),
    `a keyword-less, file-pattern-only lens must be reachable from an injected change set; got ${JSON.stringify(result.selectedAudits)}`,
  );
});

test('selector: an injected EMPTY change set is honoured, not treated as absent', async () => {
  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate3',
    provider: makeProvider(),
    changedFiles: [],
    injectedGitSpawn: async () => {
      throw new Error('git must not be spawned on the injected path');
    },
  });

  // `[]` is a caller saying "I know the set, and it is empty" — distinct from
  // omitting the option, which means "derive it yourself".
  assert.deepEqual(result.context.changedFiles, []);
  assert.equal(result.context.changedFilesCount, 0);
});

test('selector: injected changedFiles report no resolvedRef — nothing was diffed', async () => {
  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    changedFiles: ['a.js'],
  });

  assert.equal(
    result.context.resolvedRef,
    null,
    'resolvedRef names the ref the change set was diffed against; on the injected path there is none, and claiming HEAD would be a lie',
  );
});

test('selector: omitting changedFiles still derives the set from git (unchanged)', async () => {
  const seen = [];
  const fakeGitSpawn = async (_cwd, ...args) => {
    seen.push(args);
    return { status: 0, stdout: 'derived.js\n', stderr: '' };
  };

  const result = await selectAudits({
    ticketId: 500,
    gate: 'gate1',
    provider: makeProvider(),
    injectedGitSpawn: fakeGitSpawn,
  });

  assert.ok(seen.some((a) => a[0] === 'diff'));
  assert.deepEqual(result.context.changedFiles, ['derived.js']);
  assert.equal(result.context.resolvedRef, 'HEAD');
});
