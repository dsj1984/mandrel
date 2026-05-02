import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommitSubject,
  parseCliArgs,
  runTaskCommit,
} from '../../.agents/scripts/task-commit.js';

test('buildCommitSubject: produces canonical subject with scope', () => {
  const subject = buildCommitSubject({
    type: 'feat',
    scope: 'task-commit',
    title: 'Add Conventional Commit Helper',
    taskId: 123,
  });
  assert.equal(
    subject,
    'feat(task-commit): add conventional commit helper (resolves #123)',
  );
});

test('buildCommitSubject: omits scope chunk when absent or blank', () => {
  assert.equal(
    buildCommitSubject({ type: 'docs', title: 'Update README', taskId: 9 }),
    'docs: update readme (resolves #9)',
  );
  assert.equal(
    buildCommitSubject({
      type: 'docs',
      scope: '   ',
      title: 'Update README',
      taskId: 9,
    }),
    'docs: update readme (resolves #9)',
  );
});

test('buildCommitSubject: rejects unsupported types', () => {
  assert.throws(
    () => buildCommitSubject({ type: 'wibble', title: 't', taskId: 1 }),
    /unsupported type/,
  );
});

test('buildCommitSubject: rejects missing title and bad task id', () => {
  assert.throws(() =>
    buildCommitSubject({ type: 'feat', title: '', taskId: 1 }),
  );
  assert.throws(() =>
    buildCommitSubject({ type: 'feat', title: 'x', taskId: 0 }),
  );
});

test('runTaskCommit: happy path stages, commits, returns 7-char SHA + branch', () => {
  const calls = [];
  const fakeSpawn = (_cwd, ...gitArgs) => {
    calls.push(gitArgs.join(' '));
    return { status: 0, stdout: '', stderr: '' };
  };
  const fakeSync = (_cwd, ...gitArgs) => {
    calls.push(`sync:${gitArgs.join(' ')}`);
    if (gitArgs[0] === 'rev-parse') return 'deadbeefcafebabe1234567890';
    return '';
  };
  const fakeAssert = () => ({
    ok: true,
    actual: 'story-7',
    expected: 'story-7',
  });

  const result = runTaskCommit({
    storyId: 7,
    taskId: 99,
    type: 'feat',
    title: 'Wire The Thing',
    scope: 'wiring',
    paths: ['src/a.js', 'src/b.js'],
    cwd: '/fake/cwd',
    gitSpawnImpl: fakeSpawn,
    gitSyncImpl: fakeSync,
    assertBranchImpl: fakeAssert,
  });

  assert.deepEqual(result, {
    sha: 'deadbee',
    branch: 'story-7',
    subject: 'feat(wiring): wire the thing (resolves #99)',
  });
  assert.deepEqual(calls, [
    'add src/a.js src/b.js',
    'commit -m feat(wiring): wire the thing (resolves #99)',
    'sync:rev-parse HEAD',
  ]);
});

test('runTaskCommit: defaults to `git add -u` when --paths is empty', () => {
  const calls = [];
  const fakeSpawn = (_cwd, ...gitArgs) => {
    calls.push(gitArgs.join(' '));
    return { status: 0, stdout: '', stderr: '' };
  };
  const fakeSync = () => 'abcdefg7777777';
  const fakeAssert = () => ({ ok: true });

  runTaskCommit({
    storyId: 1,
    taskId: 2,
    type: 'fix',
    title: 'Fix It',
    cwd: '/fake',
    gitSpawnImpl: fakeSpawn,
    gitSyncImpl: fakeSync,
    assertBranchImpl: fakeAssert,
  });
  assert.equal(calls[0], 'add -u');
});

test('runTaskCommit: pre-commit branch mismatch is fatal — no staging happens', () => {
  let staged = false;
  const fakeSpawn = (_cwd, ...gitArgs) => {
    if (gitArgs[0] === 'add') staged = true;
    return { status: 0, stdout: '', stderr: '' };
  };
  const fakeSync = () => 'shashasha';
  const fakeAssert = () => ({
    ok: false,
    reason: 'on main, expected story-7',
  });

  assert.throws(
    () =>
      runTaskCommit({
        storyId: 7,
        taskId: 1,
        type: 'feat',
        title: 't',
        cwd: '/fake',
        gitSpawnImpl: fakeSpawn,
        gitSyncImpl: fakeSync,
        assertBranchImpl: fakeAssert,
      }),
    /pre-commit assert-branch/,
  );
  assert.equal(staged, false, 'staging must not happen when guard fails');
});

test('runTaskCommit: surfaces git commit failure (e.g. hook reject)', () => {
  const fakeSpawn = (_cwd, ...gitArgs) => {
    if (gitArgs[0] === 'commit') {
      return { status: 1, stdout: '', stderr: 'pre-commit hook failed' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const fakeSync = () => 'shashasha';
  const fakeAssert = () => ({ ok: true });

  assert.throws(
    () =>
      runTaskCommit({
        storyId: 1,
        taskId: 2,
        type: 'feat',
        title: 't',
        cwd: '/fake',
        gitSpawnImpl: fakeSpawn,
        gitSyncImpl: fakeSync,
        assertBranchImpl: fakeAssert,
      }),
    /pre-commit hook failed/,
  );
});

test('parseCliArgs: --paths multiple flag instances all collected', () => {
  const parsed = parseCliArgs([
    '--story',
    '7',
    '--task',
    '99',
    '--type',
    'feat',
    '--title',
    'Wire',
    '--paths',
    'a.js',
    '--paths',
    'b.js',
  ]);
  assert.equal(parsed.storyId, 7);
  assert.equal(parsed.taskId, 99);
  assert.deepEqual(parsed.paths, ['a.js', 'b.js']);
});
