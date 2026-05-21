/**
 * tests/single-story-close-review.test.js — contract tests for the
 * Story-scope review step injected into `single-story-close.js` by
 * Story #2839 (Epic #2815, Pluggable Code Review).
 *
 * The review step runs after `gh pr create` and:
 *   - invokes `runCodeReview` with `{ scope: 'story', baseRef: 'main',
 *     headRef: 'story-<id>', commentTargetId: <prNumber> }`,
 *   - posts the structured findings comment to the PR (not the Story),
 *   - posts a one-line cross-reference comment back on the Story issue,
 *   - fails the close non-zero when any `critical` Finding is present
 *     (and skips auto-merge enablement in that case).
 *
 * These behaviours are covered by the contract suite below. The
 * `runStoryScopeReview` helper is exercised directly (pure-ish surface)
 * and through `runSingleStoryClose` orchestration (the halt path).
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

function childProcessMock(fakeExecFileSync) {
  return {
    namedExports: {
      ...realChildProcess,
      execFileSync: fakeExecFileSync,
    },
  };
}

function fakeProviderRecorder() {
  const postedComments = [];
  let nextId = 5000;
  return {
    postedComments,
    provider: {
      getTicket: async () => ({
        id: 2839,
        state: 'open',
        title: 'Story scope review test',
        labels: ['agent::executing'],
      }),
      updateTicket: async () => {},
      postComment: async (ticketId, payload) => {
        const id = nextId++;
        postedComments.push({ ticketId, payload, id });
        return { commentId: id };
      },
      getTicketComments: async () => [],
      deleteComment: async () => {},
    },
  };
}

function fakeConfig() {
  return {
    agentSettings: { baseBranch: 'main', commands: {} },
    project: { baseBranch: 'main' },
    delivery: { codeReview: { provider: 'native' } },
    orchestration: {
      worktreeIsolation: {
        enabled: true,
        root: '.no-such-worktree-root',
        reapOnSuccess: false,
      },
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

describe('runStoryScopeReview (direct)', () => {
  it('invokes runCodeReview with story-scope envelope and posts cross-ref on Story', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const seen = { runReview: null };
    const recorder = fakeProviderRecorder();
    const runCodeReviewFn = async (opts) => {
      seen.runReview = {
        scope: opts.scope,
        ticketId: opts.ticketId,
        baseRef: opts.baseRef,
        headRef: opts.headRef,
        commentTargetId: opts.commentTargetId,
      };
      // Simulate that runCodeReview already posted to the PR.
      return {
        status: 'ok',
        severity: { critical: 0, high: 1, medium: 2, suggestion: 0 },
        posted: true,
        postedCommentId: 9001,
        commentTargetId: opts.commentTargetId,
        halted: false,
        blockerReason: null,
      };
    };
    const out = await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      runCodeReviewFn,
      progress: () => {},
    });

    assert.deepEqual(seen.runReview, {
      scope: 'story',
      ticketId: 2839,
      baseRef: 'main',
      headRef: 'story-2839',
      commentTargetId: 123,
    });
    assert.equal(out.halted, false);
    assert.equal(out.crossRefPosted, true);
    // Cross-ref must land on the Story issue, not the PR.
    assert.equal(recorder.postedComments.length, 1);
    const [{ ticketId, payload }] = recorder.postedComments;
    assert.equal(ticketId, 2839);
    assert.equal(payload.type, 'notification');
    assert.match(payload.body, /#issuecomment-9001/);
    assert.match(payload.body, /pull\/123/);
  });

  it('flags halted=true when critical findings present and still posts cross-ref', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    const out = await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      runCodeReviewFn: async () => ({
        status: 'ok',
        severity: { critical: 2, high: 0, medium: 0, suggestion: 0 },
        posted: true,
        postedCommentId: 7777,
        commentTargetId: 123,
        halted: true,
        blockerReason: '2 critical blocker(s)',
      }),
      progress: () => {},
    });
    assert.equal(out.halted, true);
    assert.equal(out.severity.critical, 2);
    assert.equal(out.crossRefPosted, true);
    assert.match(recorder.postedComments[0].payload.body, /critical:2/);
  });

  it('skips when prNumber is null', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    let ran = false;
    const out = await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://example.com/not-a-pr',
      prNumber: null,
      provider: recorder.provider,
      runCodeReviewFn: async () => {
        ran = true;
        return { halted: false };
      },
      progress: () => {},
    });
    assert.equal(out.skipped, true);
    assert.equal(out.halted, false);
    assert.equal(ran, false);
    assert.equal(recorder.postedComments.length, 0);
  });

  it('does not post cross-ref when the PR-side comment failed to post', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    const out = await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      runCodeReviewFn: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: false,
        postedCommentId: null,
        commentTargetId: 123,
        halted: false,
        blockerReason: null,
      }),
      progress: () => {},
    });
    assert.equal(out.crossRefPosted, false);
    assert.equal(recorder.postedComments.length, 0);
  });
});

describe('runSingleStoryClose review-halt orchestration', () => {
  it('throws non-zero when the Story-scope review reports critical findings and skips auto-merge', async (t) => {
    const ghCalls = [];
    t.mock.module(
      'node:child_process',
      childProcessMock((_cmd, args) => {
        ghCalls.push(args.slice());
        if (args[1] === 'list') return '';
        if (args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/444\n';
        }
        if (args[1] === 'merge') {
          throw new Error('gh merge must not run when review halts');
        }
        throw new Error(`unexpected gh: ${args.join(' ')}`);
      }),
    );
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    t.mock.module(CLOSE_VALIDATION_URL, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=halt`);
    const recorder = fakeProviderRecorder();
    await assert.rejects(
      runSingleStoryClose({
        storyId: 2839,
        cwd: '/repo',
        skipValidation: true,
        skipSync: true,
        injectedProvider: recorder.provider,
        injectedConfig: fakeConfig(),
        injectedRunCodeReview: async (opts) => {
          // Sanity: the closer must invoke with the canonical envelope.
          assert.equal(opts.scope, 'story');
          assert.equal(opts.baseRef, 'main');
          assert.equal(opts.headRef, 'story-2839');
          assert.equal(opts.commentTargetId, 444);
          return {
            status: 'ok',
            severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
            posted: true,
            postedCommentId: 8888,
            commentTargetId: 444,
            halted: true,
            blockerReason: '1 critical blocker(s)',
          };
        },
      }),
      /Story-scope review reported 1 critical blocker/i,
    );
    // gh merge must never have been spawned.
    assert.equal(
      ghCalls.find((c) => c[1] === 'merge'),
      undefined,
      'auto-merge gh call must be skipped on review halt',
    );
  });
});
