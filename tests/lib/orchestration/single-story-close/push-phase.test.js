// tests/lib/orchestration/single-story-close/push-phase.test.js
//
// The close-time push must remain subject to `pre-push`. The bypass this
// pins against was invisible for as long as it existed: hooks never fired in
// a linked worktree, so removing `--no-verify` would have changed nothing
// observable. Now that they do fire, the flag is the one thing that would put
// the delivery push back outside the gate — so it is asserted, not assumed.
//
// Issue #4990 adds the other half: running the gate is worthless if it reads
// the wrong tree. `core.hooksPath` is relative, so the invocation directory
// decides which tree `pre-push` measures — these tests pin that directory.

import assert from 'node:assert/strict';
import test from 'node:test';
import { pushStoryBranch } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/push.js';

function capture() {
  const calls = [];
  return {
    calls,
    gitSync: (cwd, ...args) => {
      calls.push({ cwd, args });
      return '';
    },
  };
}

const SHA = 'a'.repeat(40);

/** A gitSpawn world answering `rev-parse` (local) and `ls-remote` (origin). */
function gitWorld({ local = SHA, remote = SHA, lsRemoteFails = false } = {}) {
  const probes = [];
  const gitSpawn = (cwd, ...args) => {
    probes.push({ cwd, args });
    if (args[0] === 'rev-parse') {
      return local
        ? { status: 0, stdout: `${local}\n`, stderr: '' }
        : { status: 128, stdout: '', stderr: 'unknown revision' };
    }
    if (lsRemoteFails) {
      return { status: 128, stdout: '', stderr: 'Could not read from remote' };
    }
    const stdout = remote ? `${remote}\trefs/heads/story-5967\n` : '';
    return { status: 0, stdout, stderr: '' };
  };
  return { probes, gitSpawn };
}

test('pushStoryBranch pushes with -u and sets the upstream', () => {
  const { calls, gitSync } = capture();
  pushStoryBranch({
    cwd: '/repo',
    storyBranch: 'story-4943',
    gitSync,
    gitSpawn: gitWorld({ remote: null }).gitSpawn,
    progress: () => {},
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['push', '-u', 'origin', 'story-4943']);
  assert.equal(calls[0].cwd, '/repo');
});

test('pushStoryBranch carries no hook-bypass flag', () => {
  const { calls, gitSync } = capture();
  pushStoryBranch({
    cwd: '/repo',
    storyBranch: 'story-4943',
    gitSync,
    gitSpawn: gitWorld({ remote: null }).gitSpawn,
    progress: () => {},
  });
  const bypass = calls[0].args.filter((a) =>
    ['--no-verify', '--no-gpg-sign'].includes(a),
  );
  assert.deepEqual(
    bypass,
    [],
    `the delivery push must stay subject to pre-push, got: ${calls[0].args.join(' ')}`,
  );
});

test('pushStoryBranch pushes from the Story worktree when one is supplied', () => {
  const { calls, gitSync } = capture();
  pushStoryBranch({
    cwd: '/repo',
    worktreePath: '/repo/.worktrees/story-4990',
    storyBranch: 'story-4990',
    gitSync,
    gitSpawn: gitWorld({ remote: null }).gitSpawn,
    progress: () => {},
  });
  assert.equal(
    calls[0].cwd,
    '/repo/.worktrees/story-4990',
    'pre-push must resolve inside the tree being pushed, not the main checkout',
  );
});

test('pushStoryBranch falls back to the main checkout when there is no worktree', () => {
  for (const worktreePath of [null, undefined]) {
    const { calls, gitSync } = capture();
    pushStoryBranch({
      cwd: '/repo',
      worktreePath,
      storyBranch: 'story-4990',
      gitSync,
      gitSpawn: gitWorld({ remote: null }).gitSpawn,
      progress: () => {},
    });
    assert.equal(
      calls[0].cwd,
      '/repo',
      `single-tree mode pushes from the main checkout (worktreePath=${worktreePath})`,
    );
  }
});

test('pushStoryBranch surfaces a push failure as a throw', () => {
  assert.throws(
    () =>
      pushStoryBranch({
        cwd: '/repo',
        storyBranch: 'story-4943',
        gitSync: () => {
          throw new Error('remote rejected');
        },
        gitSpawn: gitWorld({ remote: null }).gitSpawn,
        progress: () => {},
      }),
    /git push failed for story-4943.*remote rejected/s,
  );
});

function pushWith(world, extra = {}) {
  const { calls, gitSync } = capture();
  const logs = [];
  const result = pushStoryBranch({
    cwd: '/repo',
    worktreePath: '/repo/.worktrees/story-5967',
    storyBranch: 'story-5967',
    gitSync,
    gitSpawn: world.gitSpawn,
    progress: (tag, msg) => logs.push(`${tag} ${msg}`),
    ...extra,
  });
  return { calls, logs, result };
}

test('pushStoryBranch skips the push when origin already holds the local tip', () => {
  const world = gitWorld();
  const { calls, logs, result } = pushWith(world);
  assert.deepEqual(result, { outcome: 'skipped-already-at-head' });
  assert.equal(calls.length, 0, 'no git push — pre-push must not re-run');
  assert.ok(
    logs.some((l) => /already at HEAD — push skipped/.test(l)),
    logs.join('\n'),
  );
  assert.deepEqual(world.probes[0].args, [
    'rev-parse',
    'refs/heads/story-5967',
  ]);
  assert.ok(
    world.probes.every((p) => p.cwd === '/repo/.worktrees/story-5967'),
    'both reads run from the directory the push would run from',
  );
});

test('pushStoryBranch pushes when origin is behind or has no such branch', () => {
  for (const remote of ['b'.repeat(40), null]) {
    const { calls, result } = pushWith(gitWorld({ remote }));
    assert.deepEqual(result, { outcome: 'pushed' });
    assert.deepEqual(calls[0].args, ['push', '-u', 'origin', 'story-5967']);
    assert.equal(calls[0].cwd, '/repo/.worktrees/story-5967');
  }
});

test('pushStoryBranch always pushes under --skip-validation, even at the tip', () => {
  const world = gitWorld();
  const { calls, result } = pushWith(world, { skipValidation: true });
  assert.deepEqual(result, { outcome: 'pushed' });
  assert.equal(calls.length, 1);
  assert.equal(world.probes.length, 0, 'no probe when pre-push is the gate');
});

test('pushStoryBranch pushes when ls-remote fails or the local tip is unreadable', () => {
  for (const world of [
    gitWorld({ lsRemoteFails: true }),
    gitWorld({ local: null }),
    {
      gitSpawn: () => {
        throw new Error('spawn exploded');
      },
    },
  ]) {
    const { calls, result } = pushWith(world);
    assert.deepEqual(result, { outcome: 'pushed' });
    assert.deepEqual(calls[0].args, ['push', '-u', 'origin', 'story-5967']);
  }
});
