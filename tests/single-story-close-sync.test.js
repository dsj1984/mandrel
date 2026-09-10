/**
 * tests/single-story-close-sync.test.js — coverage for the Story #2580
 * sync-from-base step inside `single-story-close.js`, and for the Story #4891
 * run-scoped config pin that decides WHICH base that step syncs from.
 *
 * The pure helpers (`buildSyncFailureCommentBody`, `handleSyncFailure`,
 * `pinRunScopedConfig`, `resolveRunScopedConfig`) are exercised in isolation.
 * The end-to-end integration through `runSingleStoryClose` is covered with the
 * standard injection seams (`injectedSync`, `injectedProvider`,
 * `injectedConfig`, `injectedNotify`) plus `t.mock.module` for the validation /
 * push / worktree-manager collaborators.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINES_GATE_NAMES as REAL_BASELINES_GATE_NAMES } from '../.agents/scripts/lib/close-validation/gates.js';
import { pinRunScopedConfig } from '../.agents/scripts/lib/orchestration/run-scoped-config.js';
import { runBaseSyncPhase } from '../.agents/scripts/lib/orchestration/single-story-close/phases/base-sync.js';
import {
  buildSyncFailureCommentBody,
  handleSyncFailure,
  resolveRunScopedConfig,
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
    namedExports: {
      // Story #5172 — `single-story-close/runner.js` statically imports the
      // split baselines gate names alongside the builder, so a mock that
      // omits them fails to link the module under test.
      BASELINES_GATE_NAMES: REAL_BASELINES_GATE_NAMES,
      buildDefaultGates,
    },
  });
  t.mock.module(CLOSE_VALIDATION_RUNNER_URL, {
    namedExports: { runCloseValidation },
  });
}
const WORKTREE_MANAGER_URL = pathToFileURL(
  path.resolve(REPO_ROOT, '.agents/scripts/lib/worktree-manager.js'),
).href;
const FORMAT_AUTOFIX_URL = pathToFileURL(
  path.resolve(
    REPO_ROOT,
    '.agents/scripts/lib/orchestration/story-close/format-autofix.js',
  ),
).href;

/**
 * Story #4891 — render a `story-init` receipt comment body the way
 * `renderSingleStoryInitComment` does: a fenced JSON payload behind the
 * structured-comment marker. `legacy: true` omits the `runScopedConfig` block
 * so the top-level-field fallback (receipts written before the block existed)
 * is exercised too.
 */
function storyInitComment({ baseBranch, legacy = false, extra = null }) {
  const payload = {
    storyId: 4242,
    standalone: true,
    storyBranch: 'story-4242',
    baseBranch,
    ...(legacy ? {} : { runScopedConfig: { baseBranch, ...(extra ?? {}) } }),
  };
  return [
    '<!-- ap:structured-comment type="story-init" -->',
    '',
    '## Story init (standalone)',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n');
}

/**
 * Story #2990: build a fake `lib/gh-exec.js` `gh` facade for direct
 * injection via `injectedGh`. See
 * `tests/single-story-close-orchestration.test.js#makeFakeGh` for the
 * full shape — duplicated here so this file remains self-contained.
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
    },
  };
}

function gitUtilsMock() {
  return {
    namedExports: {
      getStoryBranch: (s) => `story-${Number(s)}`,
      gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
      // refs #3685 — single-story-close reaches base-sync / changed-files
      // through the lazily-imported runner, i.e. only after this mock is
      // installed. Surface every git-utils export the chain imports at load
      // time (sync retries + the createGitInterface seam) or the loader throws.
      gitFetchWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      gitPullWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      // Story #4543 — the shared land tail (`phases/post-land.js`) reaps the
      // local story ref and fast-forwards the base in-process, putting
      // `gitSpawn` in the close import graph. Same rule as the retries above:
      // the static import resolves whether or not the tail runs, so the mock
      // must surface it. status:1 = "ref absent" (the tail's no-op path).
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
      // Story #4543 — the land tail's fast-forward probes
      // (`git-cleanup/phases/git-probes.js`) statically import this, so it is
      // now in the close import graph and the mock must surface it.
      parseWorktreePorcelain: () => [],
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

function fakeProvider({ labels = ['agent::executing'], comments } = {}) {
  let story = {
    id: 4242,
    state: 'open',
    title: 'Sync test story',
    labels: [...labels],
  };
  const updates = [];
  const posted = [];
  return {
    getTicket: async () => ({ ...story, labels: [...story.labels] }),
    // Story #4891 — close reads the run's `story-init` receipt through
    // `findStructuredComment`, which lists the ticket's comments. Omitting
    // `comments` models the absent-receipt fallback path.
    getTicketComments: async () =>
      (comments ?? []).map((body, i) => ({ id: i + 1, body })),
    postComment: async (id, { type, body }) => {
      posted.push({ id, type, body });
      return { id: 900 + posted.length };
    },
    _posted: () => posted,
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
      baseConfirmed: true,
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
      baseConfirmed: true,
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

  it('emits a recovery cd / git fetch / merge block when the base is confirmed', () => {
    const body = buildSyncFailureCommentBody({
      storyId: 1,
      storyBranch: 'story-1',
      baseBranch: 'main',
      baseConfirmed: true,
      syncCwd: '/repo',
      result: { kind: 'conflict', conflictFiles: ['a'] },
    });
    assert.match(body, /cd \/repo/);
    assert.match(body, /git fetch origin main/);
    assert.match(body, /git merge --no-edit origin\/main/);
  });

  // Story #4891 AC-3 — advising `git merge origin/<base>` against a base the
  // Story was never seeded from permanently contaminates the branch and its
  // PR diff. The advice is withheld until close has confirmed the base.
  it('withholds the base-merge advice when the base is unconfirmed', () => {
    const body = buildSyncFailureCommentBody({
      storyId: 1,
      storyBranch: 'story-1',
      baseBranch: 'develop',
      baseConfirmed: false,
      syncCwd: '/repo',
      result: { kind: 'conflict', conflictFiles: ['a'] },
    });
    assert.doesNotMatch(body, /git merge --no-edit origin\/develop/);
    assert.doesNotMatch(body, /git fetch origin develop/);
    assert.match(body, /`develop` is unconfirmed/);
    assert.match(body, /story-init/);
    // The re-run command still has to be there — the operator is blocked, not
    // stranded without a next step.
    assert.match(
      body,
      /node \.agents\/scripts\/single-story-close\.js --story 1/,
    );
    // The conflicting-file evidence is orthogonal to the advice and stays.
    assert.match(body, /Conflicting files:/);
  });

  it('defaults to withholding the base-merge advice (fails closed)', () => {
    const body = buildSyncFailureCommentBody({
      storyId: 2,
      storyBranch: 'story-2',
      baseBranch: 'main',
      syncCwd: '/repo',
      result: { kind: 'conflict', conflictFiles: ['a'] },
    });
    assert.doesNotMatch(body, /git merge --no-edit origin\/main/);
    assert.match(body, /`main` is unconfirmed/);
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

describe('pinRunScopedConfig (Story #4891 — the write half)', () => {
  it('pins project.baseBranch, defaulting to main when unset', () => {
    assert.deepEqual(pinRunScopedConfig({ project: { baseBranch: 'trunk' } }), {
      baseBranch: 'trunk',
    });
    assert.deepEqual(pinRunScopedConfig({}), { baseBranch: 'main' });
  });

  // AC-5 — the pin is registry-driven on both halves, so a second run-scoped
  // key is one registry row and needs no second mechanism.
  it('enumerates every registry row it is given', () => {
    const keys = {
      baseBranch: {
        read: (c) => c?.project?.baseBranch ?? 'main',
        label: 'project.baseBranch',
      },
      ceremonyProfile: {
        read: (c) => c?.delivery?.routing?.ceremonyProfile ?? 'standard',
        label: 'delivery.routing.ceremonyProfile',
      },
    };
    assert.deepEqual(
      pinRunScopedConfig(
        { project: { baseBranch: 'trunk' }, delivery: { routing: {} } },
        keys,
      ),
      { baseBranch: 'trunk', ceremonyProfile: 'standard' },
    );
  });
});

describe('resolveRunScopedConfig (Story #4891 — the read half)', () => {
  const provider = { id: 'unused-by-the-injected-find' };
  const findReturning = (comment) => {
    const calls = [];
    const fn = async (_provider, ticketId, type) => {
      calls.push({ ticketId, type });
      return comment;
    };
    fn.calls = calls;
    return fn;
  };

  // AC-1 — the value comes off the run's receipt, and `confirmed` is a fact
  // only a receipt read can establish.
  it('derives the base branch from the story-init receipt', async () => {
    const findCommentFn = findReturning({
      id: 1,
      body: storyInitComment({ baseBranch: 'trunk' }),
    });
    const out = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'trunk' } },
      findCommentFn,
    });
    assert.equal(out.values.baseBranch, 'trunk');
    assert.equal(out.confirmed, true);
    assert.equal(out.receiptStatus, 'found');
    assert.equal(out.warning, null);
    assert.deepEqual(findCommentFn.calls, [
      { ticketId: 4242, type: 'story-init' },
    ]);
  });

  it('reads a legacy receipt that carries the value as a top-level field', async () => {
    const out = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'main' } },
      findCommentFn: findReturning({
        id: 1,
        body: storyInitComment({ baseBranch: 'main', legacy: true }),
      }),
    });
    assert.equal(out.values.baseBranch, 'main');
    assert.equal(out.confirmed, true);
  });

  // AC-2 — fail closed, naming BOTH values. Throwing is what keeps every
  // downstream phase (gates, format-autofix, base-sync) from running.
  it('throws naming both values when the pin and current config disagree', async () => {
    await assert.rejects(
      () =>
        resolveRunScopedConfig({
          provider,
          storyId: 4242,
          config: { project: { baseBranch: 'release-3' } },
          findCommentFn: findReturning({
            id: 1,
            body: storyInitComment({ baseBranch: 'main' }),
          }),
        }),
      (err) => {
        assert.match(err.message, /run-scoped config changed mid-run/);
        assert.match(err.message, /project\.baseBranch/);
        assert.match(err.message, /pinned at init = `main`/);
        assert.match(err.message, /currently resolves to `release-3`/);
        assert.match(
          err.message,
          /No base-sync, format-autofix or gate run was\s+performed/,
        );
        return true;
      },
    );
  });

  // AC-4 — a missing receipt is a real state (the upsert is best-effort, and a
  // recovery path may close a Story whose init predates the receipt). It falls
  // back, but never silently.
  it('falls back to config with an explicit warning when the receipt is absent', async () => {
    const lines = [];
    const out = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'main' } },
      findCommentFn: findReturning(null),
      progress: (tag, msg) => lines.push({ tag, msg }),
    });
    assert.equal(out.values.baseBranch, 'main');
    assert.equal(out.confirmed, false);
    assert.equal(out.receiptStatus, 'absent');
    assert.match(out.warning, /no story-init comment on the ticket/);
    assert.match(out.warning, /falling back to the currently-resolved config/);
    assert.match(out.warning, /project\.baseBranch=`main`/);
    assert.ok(
      lines.some((l) => l.msg.includes('⚠️') && l.msg.includes(out.warning)),
      'the fallback must be announced through progress, never silent',
    );
  });

  it('falls back with a warning when the receipt carries no JSON payload', async () => {
    const out = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'main' } },
      findCommentFn: findReturning({
        id: 1,
        body: '<!-- ap:structured-comment type="story-init" -->\n\nno fence here',
      }),
    });
    assert.equal(out.confirmed, false);
    assert.equal(out.receiptStatus, 'unreadable');
    assert.match(out.warning, /no parseable JSON payload/);
  });

  it('falls back with a warning (never throws) when the comment read fails', async () => {
    const out = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'main' } },
      findCommentFn: async () => {
        throw new Error('provider down');
      },
    });
    assert.equal(out.confirmed, false);
    assert.equal(out.receiptStatus, 'provider-error');
    assert.match(out.warning, /provider down/);
  });

  it('warns rather than confirms when the receipt pins no value for a key', async () => {
    const out = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'main' } },
      findCommentFn: findReturning({
        id: 1,
        body: [
          '<!-- ap:structured-comment type="story-init" -->',
          '',
          '```json',
          JSON.stringify({ storyId: 4242, runScopedConfig: {} }),
          '```',
        ].join('\n'),
      }),
    });
    assert.equal(out.values.baseBranch, 'main');
    assert.equal(out.confirmed, false);
    assert.match(out.warning, /pins no value for project\.baseBranch/);
  });

  // AC-5 — the comparison half enumerates the same registry, so an added key
  // is enforced by the existing mechanism with no reader change.
  it('compares every registry row it is given', async () => {
    const keys = {
      baseBranch: {
        read: (c) => c?.project?.baseBranch ?? 'main',
        label: 'project.baseBranch',
      },
      ceremonyProfile: {
        read: (c) => c?.delivery?.routing?.ceremonyProfile ?? 'standard',
        label: 'delivery.routing.ceremonyProfile',
      },
    };
    const findCommentFn = findReturning({
      id: 1,
      body: storyInitComment({
        baseBranch: 'main',
        extra: { ceremonyProfile: 'standard' },
      }),
    });
    const ok = await resolveRunScopedConfig({
      provider,
      storyId: 4242,
      config: { project: { baseBranch: 'main' } },
      keys,
      findCommentFn,
    });
    assert.deepEqual(ok.values, {
      baseBranch: 'main',
      ceremonyProfile: 'standard',
    });
    assert.equal(ok.confirmed, true);

    await assert.rejects(
      () =>
        resolveRunScopedConfig({
          provider,
          storyId: 4242,
          config: {
            project: { baseBranch: 'main' },
            delivery: { routing: { ceremonyProfile: 'strict' } },
          },
          keys,
          findCommentFn,
        }),
      /delivery\.routing\.ceremonyProfile: pinned at init = `standard`, currently resolves to `strict`/,
    );
  });
});

describe('runSingleStoryClose — sync integration', () => {
  it('throws and flips agent::blocked on a sync conflict; no push happens', async (t) => {
    let pushAttempted = false;
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        ...gitUtilsMock().namedExports,
        gitSync: (_cwd, ...args) => {
          if (args[0] === 'push') pushAttempted = true;
          return '';
        },
      },
    });
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    const gh = makeFakeGh(() => {
      throw new Error('gh should not be invoked when sync fails');
    });

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=sync-conflict`);
    const provider = fakeProvider();
    await assert.rejects(
      () =>
        runSingleStoryClose({
          storyId: 4242,
          noWaitForMerge: true,
          cwd: REPO_ROOT,
          injectedProvider: provider,
          injectedConfig: fakeConfig(),
          injectedSync: async () => ({
            synced: false,
            kind: 'conflict',
            conflictFiles: ['src/x.js'],
          }),
          injectedGh: gh,
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
        ...gitUtilsMock().namedExports,
        gitSync: (_cwd, ...args) => {
          calls.push(args.slice());
          return '';
        },
      },
    });
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') return 'https://github.com/o/r/pull/1';
      if (args[1] === 'merge') return ''; // auto-merge enable
      return '';
    });

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=sync-clean`);
    const provider = fakeProvider();
    const out = await runSingleStoryClose({
      storyId: 4242,
      noWaitForMerge: true,
      cwd: REPO_ROOT,
      injectedProvider: provider,
      injectedConfig: fakeConfig(),
      injectedSync: async () => ({ synced: true, kind: 'fast-forward' }),
      injectedNotify: () => Promise.resolve(),
      injectedGh: gh,
      injectedRunCodeReview: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: false,
        postedCommentId: null,
        commentTargetId: 0,
        halted: false,
        blockerReason: null,
      }),
    });
    assert.equal(out.success, true);
    assert.equal(out.result.pushed, true);
    const push = calls.find((c) => c[0] === 'push');
    assert.ok(push, 'git push must run after a successful sync');
  });

  it('skips the sync step when skipSync=true', async (t) => {
    let syncInvoked = false;
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    const gh = makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') return 'https://github.com/o/r/pull/2';
      return '';
    });

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=sync-skip`);
    await runSingleStoryClose({
      storyId: 4242,
      cwd: REPO_ROOT,
      injectedProvider: fakeProvider(),
      injectedConfig: fakeConfig(),
      skipSync: true,
      noWaitForMerge: true,
      injectedSync: async () => {
        syncInvoked = true;
        return { synced: true, kind: 'fast-forward' };
      },
      injectedNotify: () => Promise.resolve(),
      injectedGh: gh,
      injectedRunCodeReview: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: false,
        postedCommentId: null,
        commentTargetId: 0,
        halted: false,
        blockerReason: null,
      }),
    });
    assert.equal(
      syncInvoked,
      false,
      'syncBranchFromBase must not be called when skipSync=true',
    );
  });
});

describe('runSingleStoryClose — run-scoped base pin (Story #4891)', () => {
  /**
   * `fakeConfig()` resolves `project.baseBranch` to the `main` default (its
   * legacy `agentSettings` shape carries no `project` block), so a receipt
   * pinning anything else models "a concurrent session edited `.agentrc`
   * during the implementation window".
   */
  function pinnedConfig(baseBranch) {
    return { ...fakeConfig(), project: { baseBranch } };
  }

  // AC-2 — the refusal happens before ANY of the three destructive-adjacent
  // steps, which is why it is asserted on all three at once.
  it('refuses with a config-changed error and runs no gates, autofix or sync', async (t) => {
    let pushAttempted = false;
    let autofixInvoked = false;
    let gatesBuilt = false;
    let validationRun = false;
    let syncInvoked = false;
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        ...gitUtilsMock().namedExports,
        gitSync: (_cwd, ...args) => {
          if (args[0] === 'push') pushAttempted = true;
          return '';
        },
      },
    });
    mockCloseValidation(t, {
      namedExports: {
        buildDefaultGates: () => {
          gatesBuilt = true;
          return [];
        },
        runCloseValidation: async () => {
          validationRun = true;
          return { ok: true, failed: [] };
        },
      },
    });
    t.mock.module(FORMAT_AUTOFIX_URL, {
      namedExports: {
        runBaselineUpwardWriteback: () => ({
          ran: false,
          committed: false,
          reason: 'stub',
        }),
        runScopedFormatAutofix: () => {
          autofixInvoked = true;
          return { committed: false, reason: 'clean' };
        },
      },
    });
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=pin-conflict`);
    const provider = fakeProvider({
      comments: [storyInitComment({ baseBranch: 'main' })],
    });
    await assert.rejects(
      () =>
        runSingleStoryClose({
          storyId: 4242,
          noWaitForMerge: true,
          cwd: REPO_ROOT,
          injectedProvider: provider,
          injectedConfig: pinnedConfig('release-3'),
          injectedSync: async () => {
            syncInvoked = true;
            return { synced: true, kind: 'fast-forward' };
          },
          injectedGh: makeFakeGh(() => {
            throw new Error('gh must not be invoked on a pin conflict');
          }),
        }),
      (err) => {
        assert.match(err.message, /run-scoped config changed mid-run/);
        assert.match(err.message, /pinned at init = `main`/);
        assert.match(err.message, /currently resolves to `release-3`/);
        return true;
      },
    );
    assert.equal(syncInvoked, false, 'base-sync must not run');
    assert.equal(autofixInvoked, false, 'format-autofix must not run');
    assert.equal(gatesBuilt, false, 'the gate chain must not be built');
    assert.equal(validationRun, false, 'the gate chain must not run');
    assert.equal(pushAttempted, false, 'push must not run');
  });

  // AC-1 — the base handed to base-sync is the receipt's, and AC-3 — with the
  // base confirmed against the receipt, the merge advice is emitted.
  it('base-syncs against the receipt base and advises the merge on a conflict', async (t) => {
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    const syncedFrom = [];

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=pin-confirmed`);
    const provider = fakeProvider({
      comments: [storyInitComment({ baseBranch: 'trunk' })],
    });
    await assert.rejects(() =>
      runSingleStoryClose({
        storyId: 4242,
        noWaitForMerge: true,
        cwd: REPO_ROOT,
        injectedProvider: provider,
        injectedConfig: pinnedConfig('trunk'),
        injectedSync: async ({ baseBranch }) => {
          syncedFrom.push(baseBranch);
          return {
            synced: false,
            kind: 'conflict',
            conflictFiles: ['src/x.js'],
          };
        },
        injectedGh: makeFakeGh(() => {
          throw new Error('gh must not be invoked when sync fails');
        }),
      }),
    );
    assert.deepEqual(syncedFrom, ['trunk']);
    const friction = provider._posted().find((c) => c.type === 'friction');
    assert.ok(friction, 'a friction comment must be posted');
    assert.match(friction.body, /git merge --no-edit origin\/trunk/);
  });

  // AC-4 — no receipt: close still runs, but on the announced fallback, and
  // AC-3 — an unconfirmed base withholds the merge advice.
  it('falls back with a warning when the receipt is absent and withholds merge advice', async (t) => {
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    const syncedFrom = [];

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=pin-absent`);
    // No `comments` — the best-effort init upsert never landed, or the Story
    // is being closed from a recovery path.
    const provider = fakeProvider();
    await assert.rejects(() =>
      runSingleStoryClose({
        storyId: 4242,
        noWaitForMerge: true,
        cwd: REPO_ROOT,
        injectedProvider: provider,
        injectedConfig: pinnedConfig('main'),
        injectedSync: async ({ baseBranch }) => {
          syncedFrom.push(baseBranch);
          return {
            synced: false,
            kind: 'conflict',
            conflictFiles: ['src/x.js'],
          };
        },
        injectedGh: makeFakeGh(() => {
          throw new Error('gh must not be invoked when sync fails');
        }),
      }),
    );
    assert.deepEqual(syncedFrom, ['main'], 'the fallback base is used');
    const friction = provider._posted().find((c) => c.type === 'friction');
    assert.ok(friction, 'a friction comment must be posted');
    assert.doesNotMatch(friction.body, /git merge --no-edit origin\/main/);
    assert.match(friction.body, /`main` is unconfirmed/);
  });
});

describe('runSingleStoryClose — pre-push phase order (Story #5172)', () => {
  const reviewOk = async () => ({
    status: 'ok',
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    posted: false,
    postedCommentId: null,
    commentTargetId: 0,
    halted: false,
    blockerReason: null,
  });

  /**
   * Model HEAD as a value the pre-push phases move: base-sync writes the
   * merge commit that integrates the base, close-validation observes whatever
   * HEAD it is handed, and the push sends whatever HEAD is current when it
   * runs. Under the pre-#5172 order those last two disagreed on every close
   * that merged anything — the gates validated a tree the push then replaced.
   */
  function orderHarness(t, { syncResult, gh }) {
    const order = [];
    const observed = { validatedSha: null, pushedSha: null };
    let head = 'a'.repeat(40);
    t.mock.module(GIT_UTILS_URL, {
      namedExports: {
        ...gitUtilsMock().namedExports,
        gitSync: (_cwd, ...args) => {
          if (args[0] === 'push') {
            order.push('push');
            observed.pushedSha = head;
          }
          return '';
        },
      },
    });
    mockCloseValidation(t, {
      namedExports: {
        buildDefaultGates: () => [],
        runCloseValidation: async () => {
          order.push('close-validation');
          observed.validatedSha = head;
          return { ok: true, failed: [] };
        },
      },
    });
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());
    const injectedSync = async () => {
      order.push('base-sync');
      // A merge that integrates the base writes a commit; HEAD moves.
      head = 'b'.repeat(40);
      return syncResult;
    };
    const run = (extra = {}) =>
      runSingleStoryCloseFrom(t, {
        injectedSync,
        injectedGh: gh,
        injectedRunCodeReview: reviewOk,
        ...extra,
      });
    return { order, observed, run };
  }

  let tag = 0;
  async function runSingleStoryCloseFrom(_t, opts) {
    tag += 1;
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=order-${tag}`);
    return runSingleStoryClose({
      storyId: 4242,
      noWaitForMerge: true,
      cwd: REPO_ROOT,
      injectedProvider: fakeProvider(),
      injectedConfig: fakeConfig(),
      injectedNotify: () => Promise.resolve(),
      ...opts,
    });
  }

  const happyGh = () =>
    makeFakeGh((args) => {
      if (args[1] === 'list') return [];
      if (args[1] === 'create') return 'https://github.com/o/r/pull/7';
      return '';
    });

  // AC-7 — base-sync is invoked before the validation runner.
  it('runs base-sync before close-validation', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: true, kind: 'merge-commit' },
      gh: happyGh(),
    });
    const out = await h.run();
    assert.equal(out.success, true);
    assert.deepEqual(h.order, ['base-sync', 'close-validation', 'push']);
  });

  // AC-7 — a conflict costs no gate run at all.
  it('never invokes the validation runner when base-sync conflicts', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: false, kind: 'conflict', conflictFiles: ['a.js'] },
      gh: makeFakeGh(() => {
        throw new Error('gh must not be invoked when sync fails');
      }),
    });
    await assert.rejects(() => h.run(), /Base-sync failed \(conflict\)/);
    assert.deepEqual(h.order, ['base-sync']);
  });

  // AC-8 — the validated tree is the pushed tree.
  it('pushes the exact SHA close-validation ran against', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: true, kind: 'merge-commit' },
      gh: happyGh(),
    });
    await h.run();
    assert.ok(h.observed.validatedSha, 'fixture: validation must observe HEAD');
    assert.equal(
      h.observed.pushedSha,
      h.observed.validatedSha,
      'the push must send the tree the gates validated',
    );
  });

  // AC-9 — the two skip flags keep their meanings and stay independent.
  it('--skip-sync elides only base-sync', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: true, kind: 'fast-forward' },
      gh: happyGh(),
    });
    await h.run({ skipSync: true });
    assert.deepEqual(h.order, ['close-validation', 'push']);
  });

  it('--skip-validation elides only close-validation', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: true, kind: 'fast-forward' },
      gh: happyGh(),
    });
    await h.run({ skipValidation: true });
    assert.deepEqual(h.order, ['base-sync', 'push']);
  });

  // AC-3 — the envelope half: the two entries are named individually, so a
  // reader can tell which of them a close actually exercised.
  it('names each split baselines entry in the terminal envelope gates map', async (t) => {
    const independent = {
      name: 'check-baselines-independent',
      cmd: 'x',
      args: [],
    };
    const coverage = { name: 'check-baselines-coverage', cmd: 'x', args: [] };
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    mockCloseValidation(t, {
      namedExports: {
        buildDefaultGates: () => [
          { name: 'lint', cmd: 'x', args: [] },
          independent,
          coverage,
        ],
        // The coverage-consuming entry short-circuited on shared evidence;
        // the other two ran.
        runCloseValidation: async () => ({
          ok: true,
          failed: [],
          skipped: [{ gate: coverage, reason: 'evidence-hit' }],
        }),
      },
    });
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());

    const out = await runSingleStoryCloseFrom(t, {
      injectedSync: async () => ({ synced: true, kind: 'fast-forward' }),
      injectedGh: happyGh(),
      injectedRunCodeReview: reviewOk,
    });
    assert.equal(out.terminal.gates['check-baselines-independent'], 'passed');
    assert.equal(out.terminal.gates['check-baselines-coverage'], 'skipped');
    assert.equal(
      out.terminal.gates.lint,
      undefined,
      'only the baselines entries are broken out; the rest stay rolled up under `validation`',
    );
    assert.equal(out.terminal.gates.validation, 'passed');
  });

  it('omits the baselines entries from the envelope when validation is skipped', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: true, kind: 'fast-forward' },
      gh: happyGh(),
    });
    const out = await h.run({ skipValidation: true });
    assert.equal(out.terminal.gates.validation, 'skipped');
    for (const key of Object.keys(out.terminal.gates)) {
      assert.ok(
        !key.startsWith('check-baselines'),
        `no baselines entry ran, so none may be reported; saw ${key}`,
      );
    }
  });

  it('both flags together elide both phases and still push', async (t) => {
    const h = orderHarness(t, {
      syncResult: { synced: true, kind: 'fast-forward' },
      gh: happyGh(),
    });
    const out = await h.run({ skipSync: true, skipValidation: true });
    assert.equal(out.result.pushed, true);
    assert.deepEqual(h.order, ['push']);
  });
});

describe('runBaseSyncPhase — the capture-stamp warning (Story #5267)', () => {
  /**
   * Drive the phase with a stubbed sync so the only variable is the outcome
   * envelope, and collect every `progress` line the phase emits. The warning
   * is the phase's whole job here: the worker deposits ONE creditable
   * full-suite stamp keyed on the tree, and a sync that lands tracked content
   * spends it — silently, before this.
   */
  async function runWithSync(result) {
    const lines = [];
    await runBaseSyncPhase({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-5267',
      baseBranch: 'main',
      storyBranch: 'story-5267',
      storyId: 5267,
      provider: {},
      injectedSync: async () => result,
      progress: (_tag, msg) => lines.push(msg),
    });
    return lines;
  }

  const warnings = (lines) => lines.filter((l) => l.startsWith('⚠️'));

  it('warns loudly, naming the paths, when a merge commit changed content', async () => {
    const lines = await runWithSync({
      synced: true,
      kind: 'merge-commit',
      changedPaths: ['baselines/crap.json', 'lib/git/x.js'],
    });
    const warned = warnings(lines);
    assert.ok(warned.length > 0, 'the phase must warn');
    assert.match(warned[0], /BASE MOVED/);
    assert.match(warned[0], /merge-commit/);
    assert.match(warned[0], /origin\/main/);
    assert.match(warned[0], /capture/);
    assert.ok(warned.some((l) => l.includes('baselines/crap.json')));
    assert.ok(warned.some((l) => l.includes('lib/git/x.js')));
  });

  it('stays quiet on a noop-already-current sync', async () => {
    const lines = await runWithSync({
      synced: true,
      kind: 'noop-already-current',
      changedPaths: [],
    });
    assert.deepEqual(warnings(lines), []);
    assert.ok(lines.some((l) => l.includes('noop-already-current')));
  });

  it('stays quiet on a fast-forward that changed no tracked content', async () => {
    const lines = await runWithSync({
      synced: true,
      kind: 'fast-forward',
      changedPaths: [],
    });
    assert.deepEqual(warnings(lines), []);
  });

  it('stays quiet when the sync reports no changedPaths at all', async () => {
    // A caller-supplied envelope from before the field existed must not
    // manufacture a warning out of `undefined`.
    const lines = await runWithSync({ synced: true, kind: 'fast-forward' });
    assert.deepEqual(warnings(lines), []);
  });

  it('warns on a content-changing fast-forward — it spends the stamp too', async () => {
    const lines = await runWithSync({
      synced: true,
      kind: 'fast-forward',
      changedPaths: ['docs/CHANGELOG.md'],
    });
    assert.match(warnings(lines)[0], /BASE MOVED/);
  });

  it('truncates a long path list rather than printing a diff', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `pkg/file-${i}.js`);
    const warned = warnings(
      await runWithSync({
        synced: true,
        kind: 'merge-commit',
        changedPaths: paths,
      }),
    );
    assert.match(warned[0], /20 tracked path\(s\)/);
    assert.equal(warned.at(-1), '⚠️    …and 8 more');
    // Header + 12 listed + the overflow line.
    assert.equal(warned.length, 14);
  });
});
