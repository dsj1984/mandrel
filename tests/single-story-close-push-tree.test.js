// tests/single-story-close-push-tree.test.js — Issue #4990.
//
// Close ran `git push` in the caller's `--cwd` (the main checkout) while every
// other tree-sensitive phase ran in the Story worktree. Because `core.hooksPath`
// is the relative `.husky/_`, the invocation directory is what decides which
// tree `pre-push` resolves and measures — so the gate reported on a tree that
// was not being pushed. That failed in both directions: false red when the main
// checkout sat on unrelated work, and false green whenever it happened to be
// clean.
//
// `phases/push.js` owns the `worktreePath ?? cwd` resolution and is unit-tested
// in `tests/lib/orchestration/single-story-close/push-phase.test.js`. The defect
// itself was one level up — `openAndReviewPr` was never handed `worktreePath` at
// all — so these tests drive the whole `runSingleStoryClose` pipeline and assert
// on the working directory the push actually reached. A unit test on the phase
// alone would have stayed green throughout the bug.

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINES_GATE_NAMES as REAL_BASELINES_GATE_NAMES } from '../.agents/scripts/lib/close-validation/gates.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

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
const WORKTREE_MANAGER_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/worktree-manager.js'),
).href;

const STORY_ID = 4242;

/**
 * Record every `gitSync` invocation so the test can find the push and read the
 * cwd it ran in. Mirrors `tests/single-story-close-sync.test.js#gitUtilsMock`,
 * duplicated here so this file stays self-contained (DAMP over DRY).
 *
 * `gitSpawn` returns status 1 deliberately: the wrong-tree guard fails open on
 * a non-zero status probe, which keeps this suite focused on the push cwd
 * rather than on the guard's own behaviour.
 */
function gitUtilsMock(calls) {
  return {
    namedExports: {
      getStoryBranch: (s) => `story-${Number(s)}`,
      gitSync: (cwd, ...args) => {
        calls.push({ cwd, args });
        return { status: 0, stdout: '', stderr: '' };
      },
      gitFetchWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      gitPullWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      gitSpawn: () => ({ status: 1, stdout: '', stderr: '' }),
      createGitInterface: () => ({
        gitSync: () => '',
        gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
        gitFetchWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
        gitPullWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    },
  };
}

function mockCollaborators(t, calls) {
  t.mock.module(GIT_UTILS_URL, gitUtilsMock(calls));
  t.mock.module(CLOSE_VALIDATION_GATES_URL, {
    namedExports: {
      // Story #5172 — `single-story-close/runner.js` statically imports the
      // split baselines gate names alongside the builder, so a mock that
      // omits them fails to link the module under test.
      BASELINES_GATE_NAMES: REAL_BASELINES_GATE_NAMES,
      buildDefaultGates: () => [],
    },
  });
  t.mock.module(CLOSE_VALIDATION_RUNNER_URL, {
    namedExports: {
      runCloseValidation: async () => ({ ok: true, failed: [] }),
    },
  });
  t.mock.module(WORKTREE_MANAGER_URL, {
    namedExports: {
      WorktreeManager: class {
        async reap() {}
      },
      parseWorktreePorcelain: () => [],
    },
  });
}

function makeFakeGh() {
  const dispatch = async (args) => {
    const wantsJson = Array.isArray(args) && args.includes('--json');
    const raw = args[1] === 'create' ? 'https://github.com/o/r/pull/7' : '';
    if (wantsJson) return [];
    return { stdout: raw, stderr: '', code: 0 };
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
    },
  };
}

function fakeProvider() {
  let story = {
    id: STORY_ID,
    state: 'open',
    title: 'Push-tree test story',
    labels: ['agent::executing'],
  };
  return {
    getTicket: async () => ({ ...story, labels: [...story.labels] }),
    getTicketComments: async () => [],
    postComment: async () => ({ id: 901 }),
    updateTicket: async (_id, patch) => {
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
  };
}

/**
 * `resolveWorktreePath` resolves `<cwd>/<root>/story-<id>` and probes it with
 * `existsSync`. An ABSOLUTE `root` wins over `cwd` in `path.resolve`, so
 * pointing it at a temp directory gives a deterministic worktree path without
 * writing anything into the repository checkout.
 */
function fakeConfig(worktreeRoot, { enabled = true } = {}) {
  return {
    agentSettings: { baseBranch: 'main', commands: {} },
    delivery: {
      worktreeIsolation: {
        enabled,
        root: worktreeRoot,
        reapOnSuccess: false,
      },
    },
  };
}

function closeArgs({ cwd, config }) {
  return {
    storyId: STORY_ID,
    cwd,
    injectedProvider: fakeProvider(),
    injectedConfig: config,
    skipSync: true,
    noWaitForMerge: true,
    injectedNotify: () => Promise.resolve(),
    injectedGh: makeFakeGh(),
    injectedRunCodeReview: async () => ({
      status: 'ok',
      severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
      posted: false,
      postedCommentId: null,
      commentTargetId: 0,
      halted: false,
      blockerReason: null,
    }),
  };
}

function findPush(calls) {
  const push = calls.find((c) => c.args[0] === 'push');
  assert.ok(push, 'close must run a git push');
  return push;
}

/**
 * A throwaway checkout root, so the DEFAULT `.worktrees/story-<id>` layout can
 * be exercised without creating directories inside the repository.
 *
 * `makeTempDir` nests the directory in this process's suite root and registers
 * its reaping structurally, so no per-test teardown is needed.
 */
function tempCheckout() {
  return makeTempDir('push-tree-checkout-');
}

/** A bare worktree root for the configured-`root` cases. */
function tempWorktreeRoot() {
  return makeTempDir('push-tree-root-');
}

describe('single-story-close — which tree the close-time push runs in', () => {
  // The default layout, spelled out end to end: an unconfigured
  // `worktreeIsolation.root` resolves `<cwd>/.worktrees/story-<id>`, which is
  // what a real delivery has on disk.
  it('pushes from <cwd>/.worktrees/story-<id> under the default worktree root', async (t) => {
    const checkout = tempCheckout();
    const worktreePath = path.join(checkout, '.worktrees', `story-${STORY_ID}`);
    nodeFs.mkdirSync(worktreePath, { recursive: true });

    const calls = [];
    mockCollaborators(t, calls);

    const { runSingleStoryClose } = await import(
      `${SUT_URL}?t=push-default-root`
    );
    await runSingleStoryClose(
      closeArgs({
        cwd: checkout,
        config: { agentSettings: { baseBranch: 'main', commands: {} } },
      }),
    );

    assert.equal(
      path.resolve(findPush(calls).cwd),
      path.resolve(worktreePath),
      'the default .worktrees/story-<id> layout must be the push cwd',
    );
  });

  it('pushes from the Story worktree so pre-push validates the tree being sent', async (t) => {
    const worktreeRoot = tempWorktreeRoot();
    const worktreePath = path.join(worktreeRoot, `story-${STORY_ID}`);
    nodeFs.mkdirSync(worktreePath, { recursive: true });

    const calls = [];
    mockCollaborators(t, calls);

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=push-worktree`);
    await runSingleStoryClose(
      closeArgs({ cwd: REPO_ROOT, config: fakeConfig(worktreeRoot) }),
    );

    const push = findPush(calls);
    assert.deepEqual(push.args, ['push', '-u', 'origin', `story-${STORY_ID}`]);
    assert.equal(
      path.resolve(push.cwd),
      path.resolve(worktreePath),
      'the push must run in the Story worktree — pushing from the main ' +
        'checkout makes pre-push measure a tree that is not being pushed',
    );
  });

  // Story #5533: only single-tree mode pushes from the main checkout; with
  // isolation on, close recreates a missing worktree instead.
  it('pushes from the main checkout in single-tree mode (isolation off, no worktree)', async (t) => {
    const worktreeRoot = tempWorktreeRoot();

    const calls = [];
    mockCollaborators(t, calls);

    const { runSingleStoryClose } = await import(
      `${SUT_URL}?t=push-single-tree`
    );
    await runSingleStoryClose(
      closeArgs({
        cwd: REPO_ROOT,
        config: fakeConfig(worktreeRoot, { enabled: false }),
      }),
    );

    const push = findPush(calls);
    assert.equal(
      path.resolve(push.cwd),
      path.resolve(REPO_ROOT),
      'single-tree mode has no worktree — the main checkout IS the tree ' +
        'being pushed',
    );
  });

  it('pushes without a hook-bypass flag from the worktree', async (t) => {
    const worktreeRoot = tempWorktreeRoot();
    nodeFs.mkdirSync(path.join(worktreeRoot, `story-${STORY_ID}`), {
      recursive: true,
    });

    const calls = [];
    mockCollaborators(t, calls);

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=push-no-bypass`);
    await runSingleStoryClose(
      closeArgs({ cwd: REPO_ROOT, config: fakeConfig(worktreeRoot) }),
    );

    const bypass = findPush(calls).args.filter((a) =>
      ['--no-verify', '--no-gpg-sign'].includes(a),
    );
    assert.deepEqual(
      bypass,
      [],
      'moving the push into the worktree must not relax the gate it runs',
    );
  });
});
