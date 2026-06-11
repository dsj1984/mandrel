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
 *     (`./lib/git-utils.js`, `./lib/close-validation/` modules,
 *     `./lib/worktree-manager.js`). Each test re-imports the SUT with a
 *     cache-busting query string so it picks up its own mocks. The
 *     `childProcessMock` helper spreads the real builtin's exports so
 *     sibling modules that import `spawn`/`spawnSync` keep working.
 *   - The story-state collaborator is the canonical `injectedProvider`
 *     seam already exposed by the SUT.
 */

import assert from 'node:assert/strict';
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
const CLOSE_VALIDATION_GATES_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/close-validation/gates.js'),
).href;
const CLOSE_VALIDATION_RUNNER_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/close-validation/runner.js'),
).href;

/**
 * Apply a close-validation mock across the split modules (Story #3994):
 * `buildDefaultGates` now lives in `close-validation/gates.js` and
 * `runCloseValidation` in `close-validation/runner.js`, so a single
 * legacy-shaped `{ namedExports }` bag is fanned out to both URLs.
 */
function mockCloseValidation(t, { namedExports }) {
  const { buildDefaultGates, runCloseValidation } = namedExports;
  t.mock.module(CLOSE_VALIDATION_GATES_URL, {
    namedExports: { buildDefaultGates },
  });
  t.mock.module(CLOSE_VALIDATION_RUNNER_URL, {
    namedExports: { runCloseValidation },
  });
}
const WORKTREE_MANAGER_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/worktree-manager.js'),
).href;
// Story #2990: the close-tail phases reach `gh` through the
// `lib/gh-exec.js` facade rather than direct `execFileSync('gh', …)`
// calls. Tests inject a fake `gh` facade via `injectedGh` (or pass it
// directly to `ensurePullRequest`) instead of mocking the module URL.
/**
 * Build a fake `lib/gh-exec.js` `gh` facade for direct injection into
 * `runSingleStoryClose({ injectedGh })`, `ensurePullRequest({ gh })`,
 * and `enableAutoMerge({ gh })`. The `handler(args)` callback receives
 * the argv that would have been passed to `gh` (e.g. `['pr', 'list',
 * '--head', 'story-1234', '--state', 'open', '--json', 'url']`) and may
 * either return a value or throw. For `pr list` calls (which carry
 * `--json`) the handler returns the array shape `gh --json` would emit
 * (e.g. `[{ url: 'https://…' }]`, or `[]` for "no PR"). For
 * `pr create` / `pr merge` calls (no `--json`) the handler returns the
 * URL string the legacy `execFileSync` shim used to return; the wrapper
 * normalizes it into the `{ stdout, stderr, code }` envelope the
 * `lib/gh-exec.js` facade actually produces.
 *
 * Story #2990 replaced the previous `node:child_process` /
 * `execFileSync` mock once the phase code stopped spawning `gh`
 * directly and started routing through the facade.
 */
function makeFakeGh(handler) {
  const dispatch = async (args) => {
    const wantsJson = Array.isArray(args) && args.includes('--json');
    const raw = handler(args);
    if (wantsJson) return raw ?? [];
    const text = typeof raw === 'string' ? raw : (raw?.stdout ?? '');
    return { stdout: text, stderr: '', code: 0 };
  };
  return {
    pr: {
      list: (flags = [], fields) =>
        dispatch([
          'pr',
          'list',
          ...flags,
          ...(Array.isArray(fields) && fields.length
            ? ['--json', fields.join(',')]
            : []),
        ]),
      create: (flags = []) => dispatch(['pr', 'create', ...flags]),
      merge: (id, flags = []) =>
        dispatch(['pr', 'merge', String(id), ...flags]),
      view: (id, fields) =>
        dispatch([
          'pr',
          'view',
          String(id),
          ...(Array.isArray(fields) && fields.length
            ? ['--json', fields.join(',')]
            : []),
        ]),
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
      // refs #3685 — single-story-close now reaches its phase chain (via the
      // lazily-imported runner) only after this mock is installed, so the
      // `changed-files.js` → `createGitInterface` import resolves against the
      // mock. Surface the same drop-in interface shape the real module
      // returns, or the loader throws "does not provide an export".
      createGitInterface: (..._args) => ({
        gitSync: (..._a) => '',
        gitSpawn: (..._a) => ({ status: 0, stdout: '', stderr: '' }),
        gitFetchWithRetry: async (..._a) => ({
          status: 0,
          stdout: '',
          stderr: '',
        }),
        gitPullWithRetry: async (..._a) => ({
          status: 0,
          stdout: '',
          stderr: '',
        }),
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
  it('reuses an existing open PR when gh pr list returns a URL', async () => {
    const calls = [];
    const { ensurePullRequest } = await import(`${SUT_URL}?t=ensure-reuse`);
    const gh = makeFakeGh((args) => {
      calls.push(args.slice());
      if (args[1] === 'list') {
        return [{ url: 'https://github.com/owner/repo/pull/42' }];
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const url = await ensurePullRequest({
      cwd: '/repo',
      storyId: 1234,
      storyTitle: 'Test story',
      storyBranch: 'story-1234',
      baseBranch: 'main',
      gh,
    });
    assert.equal(url, 'https://github.com/owner/repo/pull/42');
    assert.equal(calls.length, 1, 'gh pr create must not run when list hits');
    assert.equal(calls[0][1], 'list');
  });

  it('creates a fresh PR when gh pr list returns empty', async () => {
    const calls = [];
    const { ensurePullRequest } = await import(`${SUT_URL}?t=ensure-create`);
    const gh = makeFakeGh((args) => {
      calls.push(args.slice());
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/100\n';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const url = await ensurePullRequest({
      cwd: '/repo',
      storyId: 1234,
      storyTitle: 'Test story',
      storyBranch: 'story-1234',
      baseBranch: 'main',
      gh,
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
    // Story #3969: a non-conventional storyTitle is normalized to
    // Conventional-Commit form so the squash subject parses for
    // release-please. `Test story` is not conventional and `/repo` has no
    // real branch to derive a type from, so it defaults to `chore` with a
    // lowercased description, keeping the `(#id)` reference.
    assert.equal(createArgs[titleIdx + 1], 'chore: test story (#1234)');
    const bodyIdx = createArgs.indexOf('--body');
    assert.match(createArgs[bodyIdx + 1], /Closes #1234/);
  });

  it('falls back to gh pr create when gh pr list throws', async () => {
    const calls = [];
    const { ensurePullRequest } = await import(`${SUT_URL}?t=ensure-list-fail`);
    const gh = makeFakeGh((args) => {
      calls.push(args.slice());
      if (args[1] === 'list') throw new Error('auth required');
      return 'https://github.com/owner/repo/pull/200\n';
    });
    const url = await ensurePullRequest({
      cwd: '/repo',
      storyId: 9,
      storyTitle: '',
      storyBranch: 'story-9',
      baseBranch: 'main',
      gh,
    });
    assert.equal(url, 'https://github.com/owner/repo/pull/200');
    const createCall = calls[1];
    const titleIdx = createCall.indexOf('--title');
    assert.equal(
      createCall[titleIdx + 1],
      'chore: story #9 (#9)',
      'empty storyTitle falls back to the conventional `chore: story #<id> (#<id>)` form (Story #3969)',
    );
  });

  it('throws when gh pr create fails', async () => {
    const { ensurePullRequest } = await import(
      `${SUT_URL}?t=ensure-create-fail`
    );
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') throw new Error('rate limit');
      throw new Error('unreachable');
    });
    await assert.rejects(
      ensurePullRequest({
        cwd: '/repo',
        storyId: 5,
        storyTitle: 'X',
        storyBranch: 'story-5',
        baseBranch: 'main',
        gh,
      }),
      /gh pr create.*failed/i,
    );
  });
});

describe('runSingleStoryClose orchestration', () => {
  it('happy path: skipValidation=true, opens PR, enables auto-merge, rests at agent::closing (issue stays OPEN)', async (t) => {
    const ghCalls = [];
    const gh = makeFakeGh((args) => {
      ghCalls.push(args.slice());
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/123\n';
      }
      if (args[1] === 'merge') return 'ok';
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    });
    const gitCalls = [];
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        ...defaultGitUtilsMock().namedExports,
        gitSync: (...args) => {
          gitCalls.push(args);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
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

    // Story #3385 — the close path now rests the Story at `agent::closing`,
    // NOT `agent::done`. The flip still routes through
    // `transitionTicketState` (Story #2717) so the patch carries the
    // add/remove form, but the issue stays OPEN (`state: 'open'`,
    // `state_reason: null`) because the canonical mutator only closes the
    // issue on a transition to `agent::done`. The `agent::done` flip +
    // issue-close is deferred to `single-story-confirm-merge.js`.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::closing']);
    assert.ok(
      Array.isArray(patch.labels.remove) &&
        patch.labels.remove.includes('agent::executing'),
      'transitionTicketState must remove sibling agent:: states',
    );
    assert.equal(patch.state, 'open');
    assert.equal(patch.state_reason, null);
  });

  it('returns noop early when the Story is already closed', async (t) => {
    const gh = makeFakeGh(() => {
      throw new Error('gh must not be invoked when noop');
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
    });

    assert.equal(success, true);
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-closed');
    assert.equal(provider._updates().length, 0, 'no label flip on noop');
  });

  it('honours --no-auto-merge by skipping the auto-merge gh call', async (t) => {
    const ghCalls = [];
    const gh = makeFakeGh((args) => {
      ghCalls.push(args.slice());
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/77\n';
      }
      throw new Error(`gh merge must not run with --no-auto-merge`);
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
    });

    assert.equal(result.autoMergeEnabled, false);
    assert.equal(result.autoMergeReason, 'disabled-by-flag');
    assert.match(result.note, /Operator merges via GitHub UI/);
    assert.equal(ghCalls.length, 2);
  });

  it('reports pr-number-unparseable when the PR URL has no /pull/<n>', async (t) => {
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://example.com/totally-not-a-pr\n';
      }
      throw new Error('merge must not run when PR number is unparseable');
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
    });

    assert.equal(result.prNumber, null);
    assert.equal(result.autoMergeEnabled, false);
    assert.equal(result.autoMergeReason, 'pr-number-unparseable');
  });

  it('records gh-exit-<status> when auto-merge gh call fails non-zero', async (t) => {
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
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
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
    });

    assert.equal(result.prNumber, 55);
    assert.equal(result.autoMergeEnabled, false);
    assert.match(result.autoMergeReason ?? '', /gh-exit-22/);
  });

  it('runs the validation gate when skipValidation is false (happy path)', async (t) => {
    const validationCalls = [];
    // single-story-close.js builds gates directly via `buildDefaultGates`
    // from the canonical resolved config, so mocking the close-validation modules
    // intercepts the gate factory on that path.
    mockCloseValidation(t, {
      namedExports: {
        buildDefaultGates: ({ config, epicBranch }) => {
          validationCalls.push({ config, epicBranch, phase: 'build' });
          return [{ name: 'fake-gate' }];
        },
        runCloseValidation: async (opts) => {
          validationCalls.push({ phase: 'run', opts });
          return { ok: true, failed: [] };
        },
      },
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/8\n';
      }
      if (args[1] === 'merge') return 'ok';
      throw new Error('unreachable');
    });
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
      injectedGh: gh,
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
    mockCloseValidation(t, {
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
    const gh = makeFakeGh(() => {
      throw new Error('gh must not run when validation fails');
    });
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
        injectedGh: gh,
      }),
      /Gate failed: lint/,
    );
  });

  it('throws when git push fails', async (t) => {
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        ...defaultGitUtilsMock().namedExports,
        gitSync: () => {
          throw new Error('remote rejected');
        },
      },
    });
    mockCloseValidation(t, defaultCloseValidationMock());
    const gh = makeFakeGh(() => {
      throw new Error('gh must not run when push fails');
    });
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
        injectedGh: gh,
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
    // surface is touched on the close flip. Story #3385 — the close flip
    // now targets `agent::closing` (→ `In Progress` column), not
    // `agent::done`; the `Done` column flip happens at confirm-merge.
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/2717\n';
      }
      if (args[1] === 'merge') return 'ok';
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
    });

    assert.equal(success, true);
    const mutation = graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.ok(
      mutation,
      'ColumnSync must issue the updateProjectV2ItemFieldValue mutation when the Story flips to agent::closing',
    );
    assert.equal(mutation.vars.optionId, 'opt-inprog');
    assert.equal(mutation.vars.itemId, 'ITEM-1');
    assert.equal(mutation.vars.projectId, 'PROJ');
  });

  it('swallows updateTicket failures so the run still returns success', async (t) => {
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/33\n';
      }
      if (args[1] === 'merge') return 'ok';
      throw new Error('unreachable');
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      injectedGh: gh,
    });

    assert.equal(success, true);
    assert.equal(result.autoMergeEnabled, true);
  });
});

describe('runSingleStoryClose story-closing notify dispatch', () => {
  function happyGh() {
    return makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create')
        return 'https://github.com/owner/repo/pull/999\n';
      if (args[1] === 'merge') return 'ok';
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    });
  }

  function happyMocks(t) {
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, defaultWorktreeManagerMock());
  }

  async function runWithNotify({ tag, story, fakeNotify, updateThrows, gh }) {
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
      injectedGh: gh ?? happyGh(),
    });
  }

  it('fires one story-closing dispatch on the success path', async (t) => {
    happyMocks(t);
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
    // Story #3385 — close-entry fires `story-closing` (the issue stays
    // OPEN at `agent::closing`); the `story-merged` event moves to
    // confirm-merge once the PR merge is confirmed.
    assert.equal(payload.event, 'story-closing');
    assert.equal(payload.level, 'story');
    assert.equal(payload.severity, 'medium');
    assert.match(payload.message, /Story #999/);
    assert.match(payload.message, /agent::closing/);
  });

  it('does not fire when the Story is already closed (noop path)', async (t) => {
    const gh = makeFakeGh(() => {
      throw new Error('gh must not run on noop');
    });
    t.mock.module(GIT_UTILS_URL, defaultGitUtilsMock());
    mockCloseValidation(t, defaultCloseValidationMock());
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
      gh,
    });

    assert.equal(calls.length, 0);
  });

  it('does not fire when the label flip fails', async (t) => {
    happyMocks(t);
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
    happyMocks(t);
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
