/**
 * tests/single-story-close-orchestration.test.js — coverage for the
 * orchestration body of `single-story-close.js` (Story #1827).
 *
 * The companion file `single-story-close-auto-merge.test.js` covers the
 * `parsePrNumber` + `enableAutoMerge` helpers in isolation. This file
 * exercises the two larger surfaces the standalone-close path depends on:
 *
 *   - `ensurePullRequest` — the gh-probe / gh-create branch pair, plus
 *     the fall-through path when `gh pr list` errors and the recovery
 *     path through a successful `gh pr create`.
 *   - `runSingleStoryClose` — the orchestration sequence from
 *     `agent::executing` → push → PR open/reuse → auto-merge toggle →
 *     `agent::done`. Validation, push, gh, and worktree-reap collaborators
 *     are stubbed via per-test `t.mock.module` so each scenario owns its
 *     own collaborator behaviour.
 *
 * Notes on mocking strategy:
 *   - We mock `node:child_process` (for `execFileSync` calls inside
 *     `ensurePullRequest`) and the SUT's internal dependencies
 *     (`./lib/git-utils.js`, `./lib/close-validation.js`,
 *     `./lib/worktree-manager.js`). Each test re-imports the SUT with a
 *     cache-busting query string so it picks up its own mocks. The
 *     `childProcessMock` helper spreads the real builtin's exports so
 *     sibling modules that import `spawn`/`spawnSync` keep working.
 *   - The story-state collaborator is the canonical `injectedProvider`
 *     seam already exposed by the SUT.
 */

import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Build a `node:child_process` mock that pass-through every symbol except
 * `execFileSync`, which is replaced with the supplied fake. Without the
 * pass-through, sibling modules in the SUT's import graph (e.g.
 * `lib/gh-exec.js` imports `spawn`) fail to instantiate because the mock
 * replaces the whole module surface.
 */
function childProcessMock(fakeExecFileSync) {
  return {
    namedExports: {
      ...realChildProcess,
      execFileSync: fakeExecFileSync,
    },
  };
}

function makeFakeProvider({
  initialStory = {
    id: 1234,
    state: 'open',
    title: 'Test story',
    labels: ['agent::executing'],
  },
  updateThrows = false,
} = {}) {
  let story = { ...initialStory };
  const updates = [];
  return {
    getTicket: async () => ({ ...story }),
    updateTicket: async (id, patch) => {
      updates.push({ id, patch });
      if (updateThrows) throw new Error('provider failure');
      story = { ...story, ...patch };
    },
    _story: () => story,
    _updates: () => updates,
  };
}

function fakeConfig({
  baseBranch = 'main',
  reapOnSuccess = false,
  worktreeRoot = '.no-such-worktree-root',
} = {}) {
  return {
    agentSettings: { baseBranch, commands: {} },
    orchestration: {
      worktreeIsolation: {
        enabled: true,
        root: worktreeRoot,
        reapOnSuccess,
      },
    },
  };
}

function defaultGitUtilsMock({ pushImpl } = {}) {
  return {
    namedExports: {
      getStoryBranch: (_epicId, storyId) => `story-${Number(storyId)}`,
      gitSync:
        pushImpl ?? ((..._args) => ({ status: 0, stdout: '', stderr: '' })),
    },
  };
}

function defaultCloseValidationMock({
  validation = { ok: true, failed: [] },
} = {}) {
  return {
    namedExports: {
      buildDefaultGates: () => [],
      runCloseValidation: async () => validation,
    },
  };
}

function defaultWorktreeManagerMock() {
  return {
    namedExports: {
      WorktreeManager: class {
        async reap() {
          /* no-op stub */
        }
      },
    },
  };
}

describe('ensurePullRequest', () => {
  it('reuses an existing open PR when gh pr list returns a URL', async (t) => {
    const calls = [];
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        calls.push(args.slice());
        if (args[1] === 'list') {
          return 'https://github.com/owner/repo/pull/42\n';
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      }),
    );
    const { ensurePullRequest } = await import(`${SUT_URL}?t=ensure-reuse`);
    const url = ensurePullRequest({
      cwd: '/repo',
      storyId: 1234,
      storyTitle: 'Test story',
      storyBranch: 'story-1234',
      baseBranch: 'main',
    });
    assert.equal(url, 'https://github.com/owner/repo/pull/42');
    assert.equal(calls.length, 1, 'gh pr create must not run when list hits');
    assert.equal(calls[0][1], 'list');
  });

  it('creates a fresh PR when gh pr list returns empty', async (t) => {
    const calls = [];
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        calls.push(args.slice());
        if (args[1] === 'list') return '\n';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/100\n';
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      }),
    );
    const { ensurePullRequest } = await import(`${SUT_URL}?t=ensure-create`);
    const url = ensurePullRequest({
      cwd: '/repo',
      storyId: 1234,
      storyTitle: 'Test story',
      storyBranch: 'story-1234',
      baseBranch: 'main',
    });
    assert.equal(url, 'https://github.com/owner/repo/pull/100');
    assert.equal(calls.length, 2);
    const createArgs = calls[1];
    assert.equal(createArgs[1], 'create');
    assert.ok(createArgs.includes('--base'));
    assert.ok(createArgs.includes('main'));
    assert.ok(createArgs.includes('--head'));
    assert.ok(createArgs.includes('story-1234'));
    const titleIdx = createArgs.indexOf('--title');
    assert.match(createArgs[titleIdx + 1], /Test story \(#1234\)/);
    const bodyIdx = createArgs.indexOf('--body');
    assert.match(createArgs[bodyIdx + 1], /Closes #1234/);
  });

  it('falls back to gh pr create when gh pr list throws', async (t) => {
    const calls = [];
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        calls.push(args.slice());
        if (args[1] === 'list') throw new Error('auth required');
        return 'https://github.com/owner/repo/pull/200\n';
      }),
    );
    const { ensurePullRequest } = await import(`${SUT_URL}?t=ensure-list-fail`);
    const url = ensurePullRequest({
      cwd: '/repo',
      storyId: 9,
      storyTitle: '',
      storyBranch: 'story-9',
      baseBranch: 'main',
    });
    assert.equal(url, 'https://github.com/owner/repo/pull/200');
    const createCall = calls[1];
    const titleIdx = createCall.indexOf('--title');
    assert.equal(
      createCall[titleIdx + 1],
      'Story #9',
      'empty storyTitle falls back to the Story #<id> form',
    );
  });

  it('throws when gh pr create fails', async (t) => {
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') throw new Error('rate limit');
        throw new Error('unreachable');
      }),
    );
    const { ensurePullRequest } = await import(
      `${SUT_URL}?t=ensure-create-fail`
    );
    assert.throws(
      () =>
        ensurePullRequest({
          cwd: '/repo',
          storyId: 5,
          storyTitle: 'X',
          storyBranch: 'story-5',
          baseBranch: 'main',
        }),
      /gh pr create.*failed/i,
    );
  });
});

describe('runSingleStoryClose orchestration', () => {
  it('happy path: skipValidation=true, opens PR, enables auto-merge, flips to agent::done', async (t) => {
    const ghCalls = [];
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        ghCalls.push(args.slice());
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/123\n';
        }
        if (args[1] === 'merge') return 'ok';
        throw new Error(`unexpected gh: ${args.join(' ')}`);
      }),
    );
    const gitCalls = [];
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        getStoryBranch: (_e, s) => `story-${Number(s)}`,
        gitSync: (...args) => {
          gitCalls.push(args);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=happy`);
    const provider = makeFakeProvider();
    const config = fakeConfig();

    const { success, result } = await runSingleStoryClose({
      storyId: 1234,
      cwd: '/repo',
      skipValidation: true,
      injectedProvider: provider,
      injectedConfig: config,
    });

    assert.equal(success, true);
    assert.equal(result.standalone, true);
    assert.equal(result.storyId, 1234);
    assert.equal(result.storyBranch, 'story-1234');
    assert.equal(result.baseBranch, 'main');
    assert.equal(result.prUrl, 'https://github.com/owner/repo/pull/123');
    assert.equal(result.prNumber, 123);
    assert.equal(result.pushed, true);
    assert.equal(result.autoMergeEnabled, true);
    assert.equal(result.autoMergeReason, null);
    assert.equal(result.worktreeReaped, false);
    assert.match(result.note, /auto-merge enabled/i);

    const pushCall = gitCalls.find((c) => c[1] === 'push');
    assert.ok(pushCall, 'gitSync push must be called');
    assert.deepEqual(pushCall.slice(1), [
      'push',
      '--no-verify',
      '-u',
      'origin',
      'story-1234',
    ]);

    assert.equal(ghCalls.length, 3);
    assert.equal(ghCalls[2][1], 'merge');
    assert.ok(ghCalls[2].includes('--auto'));
    assert.ok(ghCalls[2].includes('--squash'));
    assert.ok(ghCalls[2].includes('--delete-branch'));

    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels, ['agent::done']);
  });

  it('returns noop early when the Story is already closed', async (t) => {
    t.mock.module(
      'node:child_process',
      childProcessMock(() => {
        throw new Error('gh must not be invoked when noop');
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=noop`);
    const provider = makeFakeProvider({
      initialStory: {
        id: 1234,
        state: 'closed',
        title: 'Done',
        labels: ['agent::done'],
      },
    });

    const { success, result } = await runSingleStoryClose({
      storyId: 1234,
      cwd: '/repo',
      skipValidation: true,
      injectedProvider: provider,
      injectedConfig: fakeConfig(),
    });

    assert.equal(success, true);
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-closed');
    assert.equal(provider._updates().length, 0, 'no label flip on noop');
  });

  it('honours --no-auto-merge by skipping the auto-merge gh call', async (t) => {
    const ghCalls = [];
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        ghCalls.push(args.slice());
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/77\n';
        }
        throw new Error(`gh merge must not run with --no-auto-merge`);
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=no-auto-merge`);
    const { result } = await runSingleStoryClose({
      storyId: 77,
      cwd: '/repo',
      skipValidation: true,
      noAutoMerge: true,
      injectedProvider: makeFakeProvider({
        initialStory: {
          id: 77,
          state: 'open',
          title: 'Manual review',
          labels: [],
        },
      }),
      injectedConfig: fakeConfig(),
    });

    assert.equal(result.autoMergeEnabled, false);
    assert.equal(result.autoMergeReason, 'disabled-by-flag');
    assert.match(result.note, /Operator merges via GitHub UI/);
    assert.equal(ghCalls.length, 2);
  });

  it('reports pr-number-unparseable when the PR URL has no /pull/<n>', async (t) => {
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://example.com/totally-not-a-pr\n';
        }
        throw new Error('merge must not run when PR number is unparseable');
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=unparseable`);
    const { result } = await runSingleStoryClose({
      storyId: 1,
      cwd: '/repo',
      skipValidation: true,
      injectedProvider: makeFakeProvider({
        initialStory: { id: 1, state: 'open', title: '', labels: [] },
      }),
      injectedConfig: fakeConfig(),
    });

    assert.equal(result.prNumber, null);
    assert.equal(result.autoMergeEnabled, false);
    assert.equal(result.autoMergeReason, 'pr-number-unparseable');
  });

  it('records gh-exit-<status> when auto-merge gh call fails non-zero', async (t) => {
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/55\n';
        }
        if (args[1] === 'merge') {
          const err = new Error('Pull request not mergeable');
          err.status = 22;
          err.stderr = Buffer.from('Pull request not mergeable');
          throw err;
        }
        throw new Error('unreachable');
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=auto-fail`);
    const { result } = await runSingleStoryClose({
      storyId: 55,
      cwd: '/repo',
      skipValidation: true,
      injectedProvider: makeFakeProvider({
        initialStory: { id: 55, state: 'open', title: 'AM fails', labels: [] },
      }),
      injectedConfig: fakeConfig(),
    });

    assert.equal(result.prNumber, 55);
    assert.equal(result.autoMergeEnabled, false);
    assert.match(result.autoMergeReason ?? '', /gh-exit-22/);
  });

  it('runs the validation gate when skipValidation is false (happy path)', async (t) => {
    const validationCalls = [];
    t.mock.module(CLOSE_VALIDATION_URL, {
      namedExports: {
        buildDefaultGates: ({ agentSettings, epicBranch }) => {
          validationCalls.push({ agentSettings, epicBranch, phase: 'build' });
          return [{ name: 'fake-gate' }];
        },
        runCloseValidation: async (opts) => {
          validationCalls.push({ phase: 'run', opts });
          return { ok: true, failed: [] };
        },
      },
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/8\n';
        }
        if (args[1] === 'merge') return 'ok';
        throw new Error('unreachable');
      }),
    );
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=validate-ok`);
    const { result } = await runSingleStoryClose({
      storyId: 8,
      cwd: '/repo',
      skipValidation: false,
      injectedProvider: makeFakeProvider({
        initialStory: {
          id: 8,
          state: 'open',
          title: 'Validated',
          labels: [],
        },
      }),
      injectedConfig: fakeConfig(),
    });

    assert.equal(result.pushed, true);
    const buildCall = validationCalls.find((c) => c.phase === 'build');
    assert.ok(buildCall, 'buildDefaultGates must be invoked');
    assert.equal(buildCall.epicBranch, 'main');
    const runCall = validationCalls.find((c) => c.phase === 'run');
    assert.ok(runCall, 'runCloseValidation must be invoked');
    assert.equal(runCall.opts.epicId, null);
    assert.equal(runCall.opts.storyId, 8);
  });

  it('throws when a validation gate fails', async (t) => {
    t.mock.module(CLOSE_VALIDATION_URL, {
      namedExports: {
        buildDefaultGates: () => [],
        runCloseValidation: async () => ({
          ok: false,
          failed: [
            {
              gate: { name: 'lint', hint: 'Run `npm run lint`.' },
              status: 1,
              cwd: '/repo',
            },
          ],
        }),
      },
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(
      'node:child_process',
      childProcessMock(() => {
        throw new Error('gh must not run when validation fails');
      }),
    );
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=validate-fail`);
    await assert.rejects(
      runSingleStoryClose({
        storyId: 11,
        cwd: '/repo',
        skipValidation: false,
        injectedProvider: makeFakeProvider({
          initialStory: {
            id: 11,
            state: 'open',
            title: 'lint fail',
            labels: [],
          },
        }),
        injectedConfig: fakeConfig(),
      }),
      /Gate failed: lint/,
    );
  });

  it('throws when git push fails', async (t) => {
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        getStoryBranch: (_e, s) => `story-${Number(s)}`,
        gitSync: () => {
          throw new Error('remote rejected');
        },
      },
    });
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(
      'node:child_process',
      childProcessMock(() => {
        throw new Error('gh must not run when push fails');
      }),
    );
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=push-fail`);
    await assert.rejects(
      runSingleStoryClose({
        storyId: 22,
        cwd: '/repo',
        skipValidation: true,
        injectedProvider: makeFakeProvider({
          initialStory: {
            id: 22,
            state: 'open',
            title: 'push fail',
            labels: [],
          },
        }),
        injectedConfig: fakeConfig(),
      }),
      /git push failed.*remote rejected/,
    );
  });

  it('swallows updateTicket failures so the run still returns success', async (t) => {
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/33\n';
        }
        if (args[1] === 'merge') return 'ok';
        throw new Error('unreachable');
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=label-fail`);
    const { success, result } = await runSingleStoryClose({
      storyId: 33,
      cwd: '/repo',
      skipValidation: true,
      injectedProvider: makeFakeProvider({
        initialStory: {
          id: 33,
          state: 'open',
          title: 'label fail',
          labels: [],
        },
        updateThrows: true,
      }),
      injectedConfig: fakeConfig(),
    });

    assert.equal(success, true);
    assert.equal(result.autoMergeEnabled, true);
  });
});
