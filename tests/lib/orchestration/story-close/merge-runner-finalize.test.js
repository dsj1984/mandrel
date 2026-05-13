/**
 * Branch-coverage harness for runFinalizeMerge / finalizeMergeIfPending /
 * runResumeMerge in `lib/orchestration/story-close/merge-runner.js`.
 *
 * Uses per-test `t.mock.module` so each test scope owns its own collaborator
 * stubs. The lock + push helpers are already covered by `merge-runner.test.js`;
 * this file targets the merge finalize / resume branches that Story #1641
 * split into smaller helpers.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const REPO_ROOT =
  'C:/Users/dsj19/Projects/agent-protocols/.worktrees/story-1641';
const gitMergeUrl = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/git-merge-orchestrator.js'),
).href;
const pushRetryUrl = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/push-epic-retry.js'),
).href;
const mergeRunnerUrl = pathToFileURL(
  path.resolve(
    REPO_ROOT,
    '.agents/scripts/lib/orchestration/story-close/merge-runner.js',
  ),
).href;

function gitStub(routes = {}) {
  const calls = [];
  return {
    calls,
    gitSpawn: (cwd, ...args) => {
      calls.push({ cwd, args });
      const key = args.join(' ');
      const route = routes[key];
      if (typeof route === 'function') return route(cwd, args);
      return route ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

function pinMergeCollab(t, { mergeResult, pushResult }) {
  t.mock.module(gitMergeUrl, {
    namedExports: { mergeFeatureBranch: () => mergeResult },
  });
  t.mock.module(pushRetryUrl, {
    namedExports: {
      pushEpicWithRetry: async () => pushResult,
      PushRetryConflictError: class extends Error {},
    },
  });
}

describe('runFinalizeMerge — happy and conflict paths (per-test mocks)', () => {
  it('completes successfully on a clean merge and exercises the verbose merge logger', async (t) => {
    // Use a mergeFeatureBranch stub that invokes the verbose logger so the
    // `buildVerboseMergeLogger` ternary branch (meta vs no-meta) gets
    // covered by the same flow that exercises the clean-merge happy path.
    const logCalls = [];
    t.mock.module(gitMergeUrl, {
      namedExports: {
        mergeFeatureBranch: (_cwd, _branch, vlog) => {
          vlog('info', 'merge', 'merging', { foo: 1 });
          vlog('info', 'merge', 'no-meta');
          return {
            merged: true,
            major: false,
            autoResolved: false,
            conflicts: { files: 0, lines: 0, fileList: [] },
          };
        },
      },
    });
    t.mock.module(pushRetryUrl, {
      namedExports: {
        pushEpicWithRetry: async () => ({ ok: true, attempts: 1 }),
        PushRetryConflictError: class extends Error {},
      },
    });
    const { runFinalizeMerge } = await import(`${mergeRunnerUrl}?t=clean`);
    const logger = {
      error: (m) => logCalls.push(m),
    };

    const stub = gitStub();
    const logs = [];
    await runFinalizeMerge({
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      storyTitle: 'Add thing',
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      orchestration: { worktreeIsolation: { enabled: false } },
      log: (tag, msg) => logs.push(`${tag}:${msg}`),
      logger,
      gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
      gitSpawn: stub.gitSpawn,
    });
    assert.ok(logs.some((l) => l.includes('Merge successful')));
    assert.ok(logCalls.some((l) => l.includes('[merge] merging {"foo":1}')));
    assert.ok(logCalls.some((l) => l === '[merge] no-meta'));
  });

  it('falls back to empty list when autoResolvedFiles is undefined', async (t) => {
    pinMergeCollab(t, {
      mergeResult: {
        merged: true,
        major: false,
        autoResolved: true,
        conflicts: { files: 1, lines: 1, fileList: ['x.js'] },
        // autoResolvedFiles intentionally omitted to exercise the `?? []` branch
      },
      pushResult: { ok: true, attempts: 1 },
    });
    const { runFinalizeMerge } = await import(
      `${mergeRunnerUrl}?t=auto-no-files`
    );
    const stub = gitStub();
    const logs = [];
    await runFinalizeMerge({
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      storyTitle: 'No autoresolvedfiles',
      storyId: 11,
      epicId: 1,
      cwd: '/tmp',
      orchestration: { worktreeIsolation: { enabled: false } },
      log: (tag, msg) => logs.push(`${tag}:${msg}`),
      logger: { error: () => {} },
      gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
      gitSpawn: stub.gitSpawn,
    });
    assert.ok(logs.some((l) => l.includes('auto-resolved minor conflicts')));
  });

  it('logs auto-resolved minor conflicts + each per-file note', async (t) => {
    pinMergeCollab(t, {
      mergeResult: {
        merged: true,
        major: false,
        autoResolved: true,
        conflicts: { files: 2, lines: 3, fileList: ['a.js', 'b.js'] },
        autoResolvedFiles: [
          { file: 'a.js', discardedLines: 4 },
          { file: 'b.js', discardedLines: 1 },
        ],
      },
      pushResult: { ok: true, attempts: 2 },
    });
    const { runFinalizeMerge } = await import(`${mergeRunnerUrl}?t=auto`);

    const stub = gitStub();
    const logs = [];
    await runFinalizeMerge({
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      storyTitle: 'Auto resolve',
      storyId: 2,
      epicId: 1,
      cwd: '/tmp',
      orchestration: { worktreeIsolation: { enabled: false } },
      log: (tag, msg) => logs.push(`${tag}:${msg}`),
      logger: { error: () => {} },
      gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
      gitSpawn: stub.gitSpawn,
    });
    assert.ok(logs.some((l) => l.includes('auto-resolved minor conflicts')));
    assert.ok(logs.some((l) => l.includes('auto-resolved a.js')));
    assert.ok(logs.some((l) => l.includes('auto-resolved b.js')));
    assert.ok(
      logs.some((l) => l.includes('Push succeeded on attempt 2')),
      'should log push-retry trailer when attempts > 1',
    );
  });

  it('throws on major merge conflict', async (t) => {
    pinMergeCollab(t, {
      mergeResult: {
        merged: false,
        major: true,
        conflicts: { files: 1, lines: 5, fileList: ['a.js'] },
      },
      pushResult: { ok: true, attempts: 1 },
    });
    const { runFinalizeMerge } = await import(`${mergeRunnerUrl}?t=major`);

    const stub = gitStub();
    await assert.rejects(
      async () =>
        runFinalizeMerge({
          epicBranch: 'epic/1',
          storyBranch: 'story-1',
          storyTitle: 'Boom',
          storyId: 3,
          epicId: 1,
          cwd: '/tmp',
          orchestration: { worktreeIsolation: { enabled: false } },
          log: () => {},
          logger: { error: () => {} },
          gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
          gitSpawn: stub.gitSpawn,
        }),
      /Major merge conflict on story close/,
    );
  });
});

describe('finalizeMergeIfPending — pending merge path', () => {
  it('commits the pending merge when MERGE_HEAD exists', async () => {
    const { finalizeMergeIfPending } = await import(mergeRunnerUrl);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-runner-test-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'deadbeef');
      const stub = gitStub();
      const logs = [];
      finalizeMergeIfPending({
        cwd: dir,
        epicBranch: 'epic/1',
        storyBranch: 'story-1',
        storyTitle: 'Resume',
        storyId: 4,
        log: (tag, msg) => logs.push(`${tag}:${msg}`),
        gitSpawn: stub.gitSpawn,
      });
      assert.ok(logs.some((l) => l.includes('finalized on epic/1')));
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].args[0], 'commit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the commit call fails (stderr → message)', async () => {
    const { finalizeMergeIfPending } = await import(mergeRunnerUrl);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-runner-test-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'deadbeef');
      const fallbackStub = {
        gitSpawn: (_cwd, ...args) => {
          if (args[0] === 'commit') {
            return { status: 1, stdout: '', stderr: 'still conflicted' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      };
      assert.throws(
        () =>
          finalizeMergeIfPending({
            cwd: dir,
            epicBranch: 'epic/1',
            storyBranch: 'story-1',
            storyTitle: 'Resume',
            storyId: 4,
            log: () => {},
            gitSpawn: fallbackStub.gitSpawn,
          }),
        /still conflicted/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to stdout then "unknown" when stderr is empty', async () => {
    const { finalizeMergeIfPending } = await import(mergeRunnerUrl);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-runner-test-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'deadbeef');
      // stderr empty, stdout populated → stdout is used.
      assert.throws(
        () =>
          finalizeMergeIfPending({
            cwd: dir,
            epicBranch: 'epic/1',
            storyBranch: 'story-1',
            storyTitle: 'Resume',
            storyId: 4,
            log: () => {},
            gitSpawn: () => ({
              status: 1,
              stdout: 'stdout-detail',
              stderr: '',
            }),
          }),
        /stdout-detail/,
      );
      // both empty → "unknown" sentinel.
      assert.throws(
        () =>
          finalizeMergeIfPending({
            cwd: dir,
            epicBranch: 'epic/1',
            storyBranch: 'story-1',
            storyTitle: 'Resume',
            storyId: 4,
            log: () => {},
            gitSpawn: () => ({ status: 1, stdout: '', stderr: '' }),
          }),
        /unknown/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rebaseStoryOnEpic — happy + sub-helper branches', () => {
  it('returns rebased: true when fetch + rebase succeed', async () => {
    const { rebaseStoryOnEpic } = await import(mergeRunnerUrl);
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-test-'));
    try {
      // Create the worktree path the resolver will compute.
      const wtPath = path.join(repoRoot, '.worktrees', 'story-9999');
      fs.mkdirSync(wtPath, { recursive: true });
      const stub = gitStub();
      const out = rebaseStoryOnEpic({
        orchestration: { worktreeIsolation: { enabled: true } },
        storyId: 9999,
        epicBranch: 'epic/1',
        storyBranch: 'story-9999',
        repoRoot,
        log: () => {},
        gitSpawn: stub.gitSpawn,
      });
      assert.equal(out.rebased, true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('returns fetch-failed when fetch errors', async () => {
    const { rebaseStoryOnEpic } = await import(mergeRunnerUrl);
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-test-'));
    try {
      const wtPath = path.join(repoRoot, '.worktrees', 'story-9998');
      fs.mkdirSync(wtPath, { recursive: true });
      const stub = gitStub({
        'fetch origin epic/1': { status: 1, stdout: '', stderr: 'no remote' },
      });
      const out = rebaseStoryOnEpic({
        orchestration: { worktreeIsolation: { enabled: true } },
        storyId: 9998,
        epicBranch: 'epic/1',
        storyBranch: 'story-9998',
        repoRoot,
        log: () => {},
        gitSpawn: stub.gitSpawn,
      });
      assert.deepEqual(out, { rebased: false, reason: 'fetch-failed' });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('aborts the rebase + returns rebase-conflict when rebase errors', async () => {
    const { rebaseStoryOnEpic } = await import(mergeRunnerUrl);
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-test-'));
    try {
      const wtPath = path.join(repoRoot, '.worktrees', 'story-9997');
      fs.mkdirSync(wtPath, { recursive: true });
      const stub = gitStub({
        'rebase origin/epic/1': { status: 1, stdout: '', stderr: 'conflict' },
      });
      const out = rebaseStoryOnEpic({
        orchestration: { worktreeIsolation: { enabled: true } },
        storyId: 9997,
        epicBranch: 'epic/1',
        storyBranch: 'story-9997',
        repoRoot,
        log: () => {},
        gitSpawn: stub.gitSpawn,
      });
      assert.deepEqual(out, { rebased: false, reason: 'rebase-conflict' });
      // assert the abort was called
      assert.ok(
        stub.calls.some(
          (c) => c.args[0] === 'rebase' && c.args[1] === '--abort',
        ),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runResumeMerge — resume path with no pending merge', () => {
  it('no-ops the finalize step and runs the push helper', async (t) => {
    t.mock.module(pushRetryUrl, {
      namedExports: {
        pushEpicWithRetry: async () => ({ ok: true, attempts: 1 }),
        PushRetryConflictError: class extends Error {},
      },
    });
    const { runResumeMerge } = await import(`${mergeRunnerUrl}?t=resume`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-runner-test-'));
    try {
      const stub = gitStub();
      await runResumeMerge({
        cwd: dir,
        epicBranch: 'epic/1',
        storyBranch: 'story-1',
        storyTitle: 'Resume',
        storyId: 5,
        epicId: 1,
        orchestration: { worktreeIsolation: { enabled: false } },
        log: () => {},
        gitSpawn: stub.gitSpawn,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
