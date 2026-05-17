import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommitSubject,
  parseArgv,
  partitionStagedForSiblingTest,
  resolveSiblingTestFlag,
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

test('parseArgv: --paths multiple flag instances all collected', () => {
  const parsed = parseArgv([
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

// ---------------------------------------------------------------------------
// Story #1399 (Epic #1386) — --require-sibling-test guard. The flag refuses to
// commit a newly-added `src/**/*.<ext>` file unless a sibling
// `<basename>.test.<ext>` is staged in the same commit.
// ---------------------------------------------------------------------------

test('partitionStagedForSiblingTest: detects new src file with no sibling test', () => {
  const stdout = ['A\tsrc/widgets/foo.js'].join('\n');
  const { missing, present } = partitionStagedForSiblingTest(stdout);
  assert.deepEqual(missing, ['src/widgets/foo.js']);
  assert.deepEqual(present, []);
});

test('partitionStagedForSiblingTest: pairs new src file with same-commit sibling test', () => {
  const stdout = ['A\tsrc/widgets/foo.js', 'A\ttests/widgets/foo.test.js'].join(
    '\n',
  );
  const { missing, present } = partitionStagedForSiblingTest(stdout);
  assert.deepEqual(missing, []);
  assert.deepEqual(present, ['src/widgets/foo.js']);
});

test('partitionStagedForSiblingTest: ignores modified src files (rule is for new modules only)', () => {
  const stdout = ['M\tsrc/widgets/foo.js'].join('\n');
  const { missing } = partitionStagedForSiblingTest(stdout);
  assert.deepEqual(missing, []);
});

test('partitionStagedForSiblingTest: ignores files outside src/ (e.g. .agents/scripts/, tests/)', () => {
  const stdout = [
    'A\t.agents/scripts/new-tool.js',
    'A\ttests/lib/standalone.test.js',
  ].join('\n');
  const { missing, present } = partitionStagedForSiblingTest(stdout);
  assert.deepEqual(missing, []);
  assert.deepEqual(present, []);
});

test('partitionStagedForSiblingTest: handles rename rows (uses target path)', () => {
  // git diff --cached --name-status emits `R<score>\told\tnew` for renames.
  const stdout = [
    'R100\tsrc/old/name.js\tsrc/new/name.js',
    'A\ttests/new/name.test.js',
  ].join('\n');
  // Renames are not `A` adds, so they don't trigger the rule even when the
  // target lives under src/. The conservative behaviour matches the helper's
  // "rename = baseline-refresh" rule rather than treating renames as new
  // modules.
  const { missing, present } = partitionStagedForSiblingTest(stdout);
  assert.deepEqual(missing, []);
  assert.deepEqual(present, []);
});

test('runTaskCommit: --require-sibling-test allows when sibling test is staged', () => {
  const stagedDiffStdout = [
    'A\tsrc/widgets/foo.js',
    'A\ttests/widgets/foo.test.js',
  ].join('\n');
  const fakeSpawn = (_cwd, ...gitArgs) => {
    if (gitArgs[0] === 'diff' && gitArgs[1] === '--cached') {
      return { status: 0, stdout: stagedDiffStdout, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const fakeSync = () => 'shashasha';
  const fakeAssert = () => ({ ok: true });

  const result = runTaskCommit({
    storyId: 1,
    taskId: 2,
    type: 'feat',
    title: 'Add Foo',
    cwd: '/fake',
    requireSiblingTest: true,
    gitSpawnImpl: fakeSpawn,
    gitSyncImpl: fakeSync,
    assertBranchImpl: fakeAssert,
  });
  assert.equal(result.subject, 'feat: add foo (resolves #2)');
});

test('runTaskCommit: --require-sibling-test rejects when sibling test is missing', () => {
  const stagedDiffStdout = ['A\tsrc/widgets/foo.js'].join('\n');
  const fakeSpawn = (_cwd, ...gitArgs) => {
    if (gitArgs[0] === 'diff' && gitArgs[1] === '--cached') {
      return { status: 0, stdout: stagedDiffStdout, stderr: '' };
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
        title: 'Add Foo',
        cwd: '/fake',
        requireSiblingTest: true,
        gitSpawnImpl: fakeSpawn,
        gitSyncImpl: fakeSync,
        assertBranchImpl: fakeAssert,
      }),
    /requireSiblingTest:.*src\/widgets\/foo\.js/s,
  );
});

test('runTaskCommit: requireSiblingTest=false (CLI override) skips the diff scan even when config is on', () => {
  const stagedDiffStdout = ['A\tsrc/widgets/foo.js'].join('\n');
  let consultedDiff = false;
  const fakeSpawn = (_cwd, ...gitArgs) => {
    if (gitArgs[0] === 'diff' && gitArgs[1] === '--cached') {
      consultedDiff = true;
      return { status: 0, stdout: stagedDiffStdout, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const fakeSync = () => 'shashasha';
  const fakeAssert = () => ({ ok: true });

  runTaskCommit({
    storyId: 1,
    taskId: 2,
    type: 'feat',
    title: 'Add Foo',
    cwd: '/fake',
    requireSiblingTest: false,
    gitSpawnImpl: fakeSpawn,
    gitSyncImpl: fakeSync,
    assertBranchImpl: fakeAssert,
    // Synthetic config — the explicit `false` CLI flag must beat this.
    resolveConfigImpl: () => ({
      agentSettings: {
        quality: { codingGuardrails: { requireSiblingTest: true } },
      },
    }),
  });
  assert.equal(
    consultedDiff,
    false,
    'sibling-test diff scan must not run when CLI flag explicitly disables it',
  );
});

test('resolveSiblingTestFlag: explicit boolean wins over config', () => {
  assert.equal(
    resolveSiblingTestFlag({
      cliFlag: false,
      resolveConfigImpl: () => ({
        agentSettings: {
          quality: { codingGuardrails: { requireSiblingTest: true } },
        },
      }),
    }),
    false,
  );
  assert.equal(
    resolveSiblingTestFlag({
      cliFlag: true,
      resolveConfigImpl: () => ({
        agentSettings: {
          quality: { codingGuardrails: { requireSiblingTest: false } },
        },
      }),
    }),
    true,
  );
});

test('resolveSiblingTestFlag: falls back to config when CLI is undefined', () => {
  assert.equal(
    resolveSiblingTestFlag({
      resolveConfigImpl: () => ({
        agentSettings: {
          quality: { codingGuardrails: { requireSiblingTest: true } },
        },
      }),
    }),
    true,
  );
  assert.equal(
    resolveSiblingTestFlag({
      resolveConfigImpl: () => ({
        agentSettings: {
          quality: { codingGuardrails: { requireSiblingTest: false } },
        },
      }),
    }),
    false,
  );
});

test('resolveSiblingTestFlag: returns false when config resolution throws', () => {
  assert.equal(
    resolveSiblingTestFlag({
      resolveConfigImpl: () => {
        throw new Error('no .agentrc.json');
      },
    }),
    false,
  );
});

test('parseArgv: --require-sibling-test / --no-require-sibling-test flags surface as boolean', () => {
  const on = parseArgv([
    '--story',
    '1',
    '--task',
    '2',
    '--type',
    'feat',
    '--title',
    't',
    '--require-sibling-test',
  ]);
  assert.equal(on.requireSiblingTest, true);

  const off = parseArgv([
    '--story',
    '1',
    '--task',
    '2',
    '--type',
    'feat',
    '--title',
    't',
    '--no-require-sibling-test',
  ]);
  assert.equal(off.requireSiblingTest, false);

  const unset = parseArgv([
    '--story',
    '1',
    '--task',
    '2',
    '--type',
    'feat',
    '--title',
    't',
  ]);
  assert.equal(unset.requireSiblingTest, undefined);
});
