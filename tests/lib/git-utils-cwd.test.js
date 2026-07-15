import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, afterEach, describe, it } from 'node:test';
import {
  __resetCleanGitEnv,
  __setGitRunners,
  gitSpawn,
  gitSync,
} from '../../.agents/scripts/lib/git-utils.js';

// Restore real git runners after this suite so any later test in the same
// worker process is not contaminated by the mocks installed below.
after(() => {
  __setGitRunners(execFileSync, spawnSync);
  __resetCleanGitEnv();
});

afterEach(() => {
  __resetCleanGitEnv();
});

describe('git-utils — explicit cwd is forwarded to the child process', () => {
  it('gitSync passes cwd through to execFileSync', () => {
    let observed = null;
    __setGitRunners(
      (_cmd, _args, opts) => {
        observed = opts.cwd;
        return 'main\n';
      },
      () => ({ status: 0, stdout: '', stderr: '' }),
    );

    const result = gitSync('/tmp/worktree-A', 'branch', '--show-current');
    assert.equal(result, 'main');
    assert.equal(observed, '/tmp/worktree-A');
  });

  it('gitSpawn passes cwd through to spawnSync', () => {
    let observed = null;
    __setGitRunners(
      () => '',
      (_cmd, _args, opts) => {
        observed = opts.cwd;
        return { status: 0, stdout: 'ok\n', stderr: '' };
      },
    );

    const result = gitSpawn('/tmp/worktree-B', 'status', '--porcelain');
    assert.equal(result.status, 0);
    assert.equal(observed, '/tmp/worktree-B');
  });

  it('two distinct cwds produce two distinct subprocess invocations', () => {
    const observed = [];
    __setGitRunners(
      (_cmd, _args, opts) => {
        observed.push(opts.cwd);
        return '';
      },
      () => ({ status: 0, stdout: '', stderr: '' }),
    );

    gitSync('/tmp/worktree-X', 'rev-parse', 'HEAD');
    gitSync('/tmp/worktree-Y', 'rev-parse', 'HEAD');

    assert.deepEqual(observed, ['/tmp/worktree-X', '/tmp/worktree-Y']);
  });
});

describe('git-utils — cleanGitEnv memoization', () => {
  it('reuses one cleaned env object across gitSync/gitSpawn calls', () => {
    const observed = [];
    __setGitRunners(
      (_cmd, _args, opts) => {
        observed.push(opts.env);
        return '';
      },
      (_cmd, _args, opts) => {
        observed.push(opts.env);
        return { status: 0, stdout: '', stderr: '' };
      },
    );

    gitSync('/tmp/a', 'status');
    gitSpawn('/tmp/b', 'status');
    gitSync('/tmp/c', 'status');

    assert.equal(observed.length, 3);
    assert.equal(observed[0], observed[1]);
    assert.equal(observed[1], observed[2]);
    assert.ok(
      Object.isFrozen(observed[0]),
      'memoized env must be frozen against accidental mutation',
    );
  });

  it('strips GIT_* from the cleaned env and ignores later process.env.GIT_*', () => {
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = '/tmp/should-not-leak';
    try {
      __resetCleanGitEnv();
      let env;
      __setGitRunners(
        (_cmd, _args, opts) => {
          env = opts.env;
          return '';
        },
        () => ({ status: 0, stdout: '', stderr: '' }),
      );
      gitSync('/tmp/a', 'status');
      assert.equal(env.GIT_DIR, undefined);
      // A later GIT_* mutation on process.env must not appear either —
      // the memoized snapshot never carried GIT_* keys.
      process.env.GIT_WORK_TREE = '/tmp/also-should-not-leak';
      gitSync('/tmp/b', 'status');
      assert.equal(env.GIT_WORK_TREE, undefined);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
      delete process.env.GIT_WORK_TREE;
    }
  });

  it('__resetCleanGitEnv forces a rebuild on the next call', () => {
    const marker = `MANDREL_CLEAN_GIT_ENV_${Date.now()}`;
    const observed = [];
    __setGitRunners(
      (_cmd, _args, opts) => {
        observed.push(opts.env);
        return '';
      },
      () => ({ status: 0, stdout: '', stderr: '' }),
    );

    gitSync('/tmp/a', 'status');
    process.env[marker] = '1';
    __resetCleanGitEnv();
    gitSync('/tmp/b', 'status');
    delete process.env[marker];

    assert.notEqual(observed[0], observed[1]);
    assert.equal(observed[0][marker], undefined);
    assert.equal(observed[1][marker], '1');
  });
});
