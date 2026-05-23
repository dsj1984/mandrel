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
// Epic #2880 / F14B: single-story-close.js now reaches buildDefaultGates
// indirectly via `legacy-settings-bag.js#buildGatesFromConfig`. Mocks on
// CLOSE_VALIDATION_URL don't intercept that transitive path, so tests
// that assert on buildDefaultGates being invoked must also mock the
// legacy-settings-bag module.
const LEGACY_SETTINGS_BAG_URL = pathToFileURL(
  path.resolve(
    REPO_ROOT,
    '.agents/scripts/lib/orchestration/story-close/legacy-settings-bag.js',
  ),
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
    project: { baseBranch, commands: {} },
    delivery: {
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
      // Story #2580 sync-from-base imports these at module load. Even
      // with `skipSync: true` the static import resolves, so the mock
      // must surface no-op variants or the loader throws.
      gitFetchWithRetry: async (..._args) => ({
        status: 0,
        stdout: '',
        stderr: '',
      }),
      gitPullWithRetry: async (..._args) => ({
        status: 0,
        stdout: '',
        stderr: '',
      }),
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

/**
 * Story #2839 — stub the Story-scope review runner so the orchestration
 * tests never reach the real `runCodeReview` (which would shell out to
 * the native review adapter and try to `git diff main...story-<id>` in
 * the test cwd). The default returns a clean envelope with no findings;
 * tests that care about review semantics pass their own stub.
 */
function noopReview() {
  return async () => ({
    status: 'ok',
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    posted: false,
    postedCommentId: null,
    commentTargetId: 0,
    halted: false,
    blockerReason: null,
  });
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
      skipSync: true,
      injectedProvider: provider,
      injectedConfig: config,
      injectedRunCodeReview: noopReview(),
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

    // The flip routes through `transitionTicketState` (Story #2717), so
    // the patch carries the add/remove form rather than a raw labels
    // array, plus the issue-close mirror (`state: 'closed'`,
    // `state_reason: 'completed'`) that the canonical mutator emits for
    // every `agent::done` transition.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::done']);
    assert.ok(
      Array.isArray(patch.labels.remove) &&
        patch.labels.remove.includes('agent::executing'),
      'transitionTicketState must remove sibling agent:: states',
    );
    assert.equal(patch.state, 'closed');
    assert.equal(patch.state_reason, 'completed');
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
      skipSync: true,
      injectedProvider: provider,
      injectedConfig: fakeConfig(),
      injectedRunCodeReview: noopReview(),
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
      skipSync: true,
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
      injectedRunCodeReview: noopReview(),
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
      skipSync: true,
      injectedProvider: makeFakeProvider({
        initialStory: { id: 1, state: 'open', title: '', labels: [] },
      }),
      injectedConfig: fakeConfig(),
      injectedRunCodeReview: noopReview(),
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
      skipSync: true,
      injectedProvider: makeFakeProvider({
        initialStory: { id: 55, state: 'open', title: 'AM fails', labels: [] },
      }),
      injectedConfig: fakeConfig(),
      injectedRunCodeReview: noopReview(),
    });

    assert.equal(result.prNumber, 55);
    assert.equal(result.autoMergeEnabled, false);
    assert.match(result.autoMergeReason ?? '', /gh-exit-22/);
  });

  it('runs the validation gate when skipValidation is false (happy path)', async (t) => {
    const validationCalls = [];
    // Mock both the direct gate factory and the legacy-settings-bag
    // bridge that single-story-close.js now reaches through. Without
    // the bag mock, buildGatesFromConfig calls the un-mocked
    // buildDefaultGates and the test never observes its invocation.
    t.mock.module(LEGACY_SETTINGS_BAG_URL, {
      namedExports: {
        buildGatesFromConfig: (config, opts) => {
          validationCalls.push({
            agentSettings: config,
            epicBranch: opts?.epicBranch ?? 'main',
            phase: 'build',
          });
          return [{ name: 'fake-gate' }];
        },
      },
    });
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
      skipSync: true,
      injectedProvider: makeFakeProvider({
        initialStory: {
          id: 8,
          state: 'open',
          title: 'Validated',
          labels: [],
        },
      }),
      injectedConfig: fakeConfig(),
      injectedRunCodeReview: noopReview(),
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
        skipSync: true,
        injectedProvider: makeFakeProvider({
          initialStory: {
            id: 11,
            state: 'open',
            title: 'lint fail',
            labels: [],
          },
        }),
        injectedConfig: fakeConfig(),
        injectedRunCodeReview: noopReview(),
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
        skipSync: true,
        injectedProvider: makeFakeProvider({
          initialStory: {
            id: 22,
            state: 'open',
            title: 'push fail',
            labels: [],
          },
        }),
        injectedConfig: fakeConfig(),
        injectedRunCodeReview: noopReview(),
      }),
      /git push failed.*remote rejected/,
    );
  });

  it('routes the label flip through transitionTicketState so ColumnSync attempts a Projects v2 mutation', async (t) => {
    // Story #2717 — regression guard. The pre-fix path called
    // `provider.updateTicket({ labels })` directly, which skipped
    // `syncProjectStatusColumn` and left the GitHub Projects board on
    // the Story's prior status column for the entire run. This test
    // pins the new contract by asserting that ColumnSync's GraphQL
    // surface is touched on the flip to `agent::done`.
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/2717\n';
        }
        if (args[1] === 'merge') return 'ok';
        throw new Error(`unexpected gh: ${args.join(' ')}`);
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const graphqlCalls = [];
    const base = makeFakeProvider({
      initialStory: {
        id: 2717,
        state: 'open',
        title: 'Column sync regression',
        labels: ['agent::executing'],
      },
    });
    const provider = {
      ...base,
      projectNumber: 1,
      owner: 'owner',
      repo: 'repo',
      async graphql(query, vars) {
        graphqlCalls.push({ query, vars });
        if (query.includes('viewer {')) {
          return {
            viewer: {
              projectV2: {
                id: 'PROJ',
                field: {
                  id: 'FIELD',
                  options: [
                    { id: 'opt-done', name: 'Done' },
                    { id: 'opt-inprog', name: 'In Progress' },
                  ],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ITEM-1', project: { id: 'PROJ' } }],
                },
              },
            },
          };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: vars.itemId },
            },
          };
        }
        return {};
      },
    };

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=column-sync`);
    const { success } = await runSingleStoryClose({
      storyId: 2717,
      cwd: '/repo',
      skipValidation: true,
      skipSync: true,
      injectedProvider: provider,
      injectedConfig: fakeConfig(),
      injectedRunCodeReview: noopReview(),
    });

    assert.equal(success, true);
    const mutation = graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.ok(
      mutation,
      'ColumnSync must issue the updateProjectV2ItemFieldValue mutation when the Story flips to agent::done',
    );
    assert.equal(mutation.vars.optionId, 'opt-done');
    assert.equal(mutation.vars.itemId, 'ITEM-1');
    assert.equal(mutation.vars.projectId, 'PROJ');
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
      skipSync: true,
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
      injectedRunCodeReview: noopReview(),
    });

    assert.equal(success, true);
    assert.equal(result.autoMergeEnabled, true);
  });
});

describe('runSingleStoryClose story-merged notify dispatch', () => {
  function happyGhMock(t) {
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        if (args[1] === 'list') return '';
        if (args[1] === 'create')
          return 'https://github.com/owner/repo/pull/999\n';
        if (args[1] === 'merge') return 'ok';
        throw new Error(`unexpected gh: ${args.join(' ')}`);
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());
  }

  async function runWithNotify({ tag, story, fakeNotify, updateThrows }) {
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=${tag}`);
    return runSingleStoryClose({
      storyId: story.id,
      cwd: '/repo',
      skipValidation: true,
      skipSync: true,
      injectedProvider: makeFakeProvider({
        initialStory: story,
        updateThrows,
      }),
      injectedConfig: fakeConfig(),
      injectedNotify: fakeNotify,
      injectedRunCodeReview: noopReview(),
    });
  }

  it('fires one story-merged dispatch on the success path', async (t) => {
    happyGhMock(t);
    const calls = [];
    await runWithNotify({
      tag: 'notify-happy',
      story: { id: 999, state: 'open', title: 'Notify happy', labels: [] },
      fakeNotify: async (ticketId, payload) =>
        calls.push({ ticketId, payload }),
    });

    assert.equal(calls.length, 1);
    const [{ ticketId, payload }] = calls;
    assert.equal(ticketId, 999);
    assert.equal(payload.event, 'story-merged');
    assert.equal(payload.level, 'story');
    assert.equal(payload.severity, 'medium');
    assert.match(payload.message, /Story #999/);
    assert.match(payload.message, /agent::done/);
  });

  it('does not fire when the Story is already closed (noop path)', async (t) => {
    t.mock.module(
      'node:child_process',
      childProcessMock(() => {
        throw new Error('gh must not run on noop');
      }),
    );
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());

    const calls = [];
    await runWithNotify({
      tag: 'notify-noop',
      story: {
        id: 999,
        state: 'closed',
        title: 'Closed',
        labels: ['agent::done'],
      },
      fakeNotify: async (...args) => calls.push(args),
    });

    assert.equal(calls.length, 0);
  });

  it('does not fire when the label flip fails', async (t) => {
    happyGhMock(t);
    const calls = [];
    const { success } = await runWithNotify({
      tag: 'notify-label-fail',
      story: { id: 1001, state: 'open', title: 'Label fail', labels: [] },
      updateThrows: true,
      fakeNotify: async (...args) => calls.push(args),
    });

    assert.equal(success, true);
    assert.equal(calls.length, 0);
  });

  it('swallows notify failures and still returns success', async (t) => {
    happyGhMock(t);
    const { success, result } = await runWithNotify({
      tag: 'notify-throws',
      story: { id: 1002, state: 'open', title: 'Notify throws', labels: [] },
      fakeNotify: async () => {
        throw new Error('webhook offline');
      },
    });

    assert.equal(success, true);
    assert.equal(result.autoMergeEnabled, true);
  });
});
