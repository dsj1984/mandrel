/**
 * tests/single-story-close-sync.test.js — coverage for the Story #2580
 * sync-from-base step inside `single-story-close.js`.
 *
 * The pure helpers (`buildSyncFailureCommentBody`, `handleSyncFailure`)
 * are exercised in isolation. The end-to-end integration through
 * `runSingleStoryClose` is covered with the standard injection seams
 * (`injectedSync`, `injectedProvider`, `injectedConfig`, `injectedNotify`)
 * plus `t.mock.module` for the validation / push / worktree-manager
 * collaborators.
 */

import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildSyncFailureCommentBody,
  handleSyncFailure,
} from '../.agents/scripts/single-story-close.js';

const REPO_ROOT = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  .replace(/\\/g, '/');

const SUT_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/single-story-close.js'),
).href;
const GIT_UTILS_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/git-utils.js'),
).href;
const CLOSE_VALIDATION_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/close-validation.js'),
).href;
const WORKTREE_MANAGER_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/worktree-manager.js'),
).href;

function childProcessMock(fakeExecFileSync) {
  return {
    namedExports: {
      ...realChildProcess,
      execFileSync: fakeExecFileSync,
    },
  };
}

function gitUtilsMock() {
  return {
    namedExports: {
      getStoryBranch: (_e, s) => `story-${Number(s)}`,
      gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
    },
  };
}

function closeValidationMock() {
  return {
    namedExports: {
      buildDefaultGates: () => [],
      runCloseValidation: async () => ({ ok: true, failed: [] }),
    },
  };
}

function worktreeManagerMock() {
  return {
    namedExports: {
      WorktreeManager: class {
        async reap() {}
      },
    },
  };
}

function fakeConfig() {
  return {
    agentSettings: { baseBranch: 'main', commands: {} },
    orchestration: {
      worktreeIsolation: {
        enabled: false,
        root: '.no-such-worktree-root',
        reapOnSuccess: false,
      },
    },
  };
}

function fakeProvider({ labels = ['agent::executing'] } = {}) {
  let story = {
    id: 4242,
    state: 'open',
    title: 'Sync test story',
    labels: [...labels],
  };
  const updates = [];
  return {
    getTicket: async () => ({ ...story, labels: [...story.labels] }),
    updateTicket: async (id, patch) => {
      updates.push({ id, patch });
      if (patch.labels) {
        const add = patch.labels.add ?? [];
        const remove = patch.labels.remove ?? [];
        story = {
          ...story,
          labels: [
            ...story.labels.filter((l) => !remove.includes(l)),
            ...add.filter((l) => !story.labels.includes(l)),
          ],
        };
      }
    },
    _updates: () => updates,
    _labels: () => [...story.labels],
  };
}

describe('buildSyncFailureCommentBody', () => {
  it('includes conflicting file list when kind=conflict', () => {
    const body = buildSyncFailureCommentBody({
      storyId: 100,
      storyBranch: 'story-100',
      baseBranch: 'main',
      syncCwd: '/repo/.worktrees/story-100',
      result: {
        kind: 'conflict',
        conflictFiles: ['src/foo.js', 'src/bar.js'],
      },
    });
    assert.match(body, /Base-sync conflict on close: story-100/);
    assert.match(body, /Conflicting files:/);
    assert.match(body, /`src\/foo\.js`/);
    assert.match(body, /`src\/bar\.js`/);
    assert.match(
      body,
      /node \.agents\/scripts\/single-story-close\.js --story 100/,
    );
  });

  it('includes truncated stderr when kind=fetch-failed', () => {
    const body = buildSyncFailureCommentBody({
      storyId: 7,
      storyBranch: 'story-7',
      baseBranch: 'main',
      syncCwd: '/repo',
      result: {
        kind: 'fetch-failed',
        stderr: 'fatal: unable to access "https://example.invalid": 403',
      },
    });
    assert.match(body, /Base-sync failed on close \(fetch-failed\)/);
    assert.match(body, /git stderr:/);
    assert.match(body, /unable to access/);
  });

  it('emits a recovery cd / git fetch / merge block', () => {
    const body = buildSyncFailureCommentBody({
      storyId: 1,
      storyBranch: 'story-1',
      baseBranch: 'main',
      syncCwd: '/repo',
      result: { kind: 'conflict', conflictFiles: ['a'] },
    });
    assert.match(body, /cd \/repo/);
    assert.match(body, /git fetch origin main/);
    assert.match(body, /git merge --no-edit origin\/main/);
  });
});

describe('handleSyncFailure', () => {
  it('posts a friction comment and flips Story to agent::blocked', async () => {
    const provider = fakeProvider();
    const messages = [];
    const progress = (tag, msg) => messages.push({ tag, msg });
    await handleSyncFailure({
      provider,
      storyId: 4242,
      syncCwd: '/repo',
      baseBranch: 'main',
      storyBranch: 'story-4242',
      result: { kind: 'conflict', conflictFiles: ['src/x.js'] },
      progress,
    });
    // Two provider mutations: comment upsert (best-effort via
    // upsertStructuredComment which goes through provider methods) and
    // the label flip.
    const labelUpdate = provider
      ._updates()
      .find((u) => u.patch.labels?.add?.includes('agent::blocked'));
    assert.ok(labelUpdate, 'agent::blocked label flip must be issued');
    assert.deepEqual(labelUpdate.patch.labels.add, ['agent::blocked']);
    assert.ok(
      labelUpdate.patch.labels.remove.includes('agent::executing'),
      'agent::executing must be removed',
    );
    assert.ok(
      provider._labels().includes('agent::blocked'),
      'final label set must include agent::blocked',
    );
  });

  it('does not throw when comment upsert fails (best-effort)', async () => {
    const provider = {
      // upsertStructuredComment indirectly calls findCommentByMarker /
      // listComments; we make every call throw to simulate a hostile
      // provider and assert the helper still runs the label flip.
      getTicket: async () => {
        throw new Error('provider down');
      },
      listComments: async () => {
        throw new Error('provider down');
      },
      createComment: async () => {
        throw new Error('provider down');
      },
      updateComment: async () => {
        throw new Error('provider down');
      },
      updateTicket: async () => {
        throw new Error('provider down');
      },
    };
    await assert.doesNotReject(() =>
      handleSyncFailure({
        provider,
        storyId: 99,
        syncCwd: '/repo',
        baseBranch: 'main',
        storyBranch: 'story-99',
        result: { kind: 'fetch-failed', stderr: 'boom' },
        progress: () => {},
      }),
    );
  });
});

describe('runSingleStoryClose — sync integration', () => {
  it('throws and flips agent::blocked on a sync conflict; no push happens', async (t) => {
    let pushAttempted = false;
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        getStoryBranch: (_e, s) => `story-${Number(s)}`,
        gitSync: (_cwd, ...args) => {
          if (args[0] === 'push') pushAttempted = true;
          return '';
        },
      },
    });
    t.mock.module(CLOSE_VALIDATION_URL, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    t.mock.module(
      'node:child_process',
      childProcessMock(() => {
        throw new Error('gh should not be invoked when sync fails');
      }),
    );

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=sync-conflict`);
    const provider = fakeProvider();
    await assert.rejects(
      () =>
        runSingleStoryClose({
          storyId: 4242,
          cwd: REPO_ROOT,
          injectedProvider: provider,
          injectedConfig: fakeConfig(),
          injectedSync: async () => ({
            synced: false,
            kind: 'conflict',
            conflictFiles: ['src/x.js'],
          }),
        }),
      /Base-sync failed \(conflict\).*src\/x\.js/,
    );
    assert.equal(pushAttempted, false, 'push must not run on sync failure');
    assert.ok(
      provider._labels().includes('agent::blocked'),
      'Story must be transitioned to agent::blocked',
    );
  });

  it('proceeds to push when sync is a clean fast-forward', async (t) => {
    const calls = [];
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        getStoryBranch: (_e, s) => `story-${Number(s)}`,
        gitSync: (_cwd, ...args) => {
          calls.push(args.slice());
          return '';
        },
      },
    });
    t.mock.module(CLOSE_VALIDATION_URL, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') return 'https://github.com/o/r/pull/1';
        if (args[1] === 'merge') return ''; // auto-merge enable
        return '';
      }),
    );

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=sync-clean`);
    const provider = fakeProvider();
    const out = await runSingleStoryClose({
      storyId: 4242,
      cwd: REPO_ROOT,
      injectedProvider: provider,
      injectedConfig: fakeConfig(),
      injectedSync: async () => ({ synced: true, kind: 'fast-forward' }),
      injectedNotify: () => Promise.resolve(),
    });
    assert.equal(out.success, true);
    assert.equal(out.result.pushed, true);
    const push = calls.find((c) => c[0] === 'push');
    assert.ok(push, 'git push must run after a successful sync');
  });

  it('skips the sync step when skipSync=true', async (t) => {
    let syncInvoked = false;
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') return 'https://github.com/o/r/pull/2';
        return '';
      }),
    );

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=sync-skip`);
    await runSingleStoryClose({
      storyId: 4242,
      cwd: REPO_ROOT,
      injectedProvider: fakeProvider(),
      injectedConfig: fakeConfig(),
      skipSync: true,
      injectedSync: async () => {
        syncInvoked = true;
        return { synced: true, kind: 'fast-forward' };
      },
      injectedNotify: () => Promise.resolve(),
    });
    assert.equal(
      syncInvoked,
      false,
      'syncBranchFromBase must not be called when skipSync=true',
    );
  });
});
