/**
 * tests/single-story-close-review.test.js — contract tests for the
 * Story-scope review step injected into `single-story-close.js` by
 * Story #2839 (Epic #2815, Pluggable Code Review).
 *
 * The review step runs after `gh pr create` and:
 *   - invokes `runCodeReview` with `{ scope: 'story', baseRef: 'origin/main',
 *     headRef: 'story-<id>', commentTargetId: <prNumber> }` — the remote-tracking
 *     ref base-sync merged from, never the bare local branch (Story #5325),
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINES_GATE_NAMES as REAL_BASELINES_GATE_NAMES } from '../.agents/scripts/lib/close-validation/gates.js';

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

/**
 * Story #2990: see
 * `tests/single-story-close-orchestration.test.js#makeFakeGh` for the
 * full contract.
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

/**
 * A `gitSpawn` stub for the review phase's base-ref resolution (Story #5325).
 *
 * `resolveBase: false` models the fail-safe state — a `--skip-sync` close or a
 * remote-less checkout where `origin/<base>` was never fetched. `diff` maps a
 * `<base>...<head>` range to the file list `git diff --name-only` would print
 * for it, so a test can give the stale local ref and the remote ref *different*
 * change sets and assert which one the review actually scored.
 */
function gitSpawnStub({ resolveBase = true, diff = {} } = {}) {
  return (_cwd, ...args) => {
    const miss = { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') {
      return resolveBase
        ? { status: 0, stdout: 'deadbeefdeadbeef\n', stderr: '' }
        : miss;
    }
    if (args[0] === 'diff' && args[1] === '--name-only') {
      const files = diff[args[2]];
      if (!files) return miss;
      return { status: 0, stdout: `${files.join('\n')}\n`, stderr: '' };
    }
    return miss;
  };
}

function fakeProviderRecorder() {
  const postedComments = [];
  const updates = [];
  let nextId = 5000;
  return {
    postedComments,
    updates,
    provider: {
      getTicket: async () => ({
        id: 2839,
        state: 'open',
        title: 'Story scope review test',
        labels: ['agent::executing'],
      }),
      updateTicket: async (ticketId, payload) => {
        updates.push({ ticketId, payload });
      },
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
    delivery: { codeReview: { providers: [{ name: 'native' }] } },
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
      //
      // Story #5325 — the review phase now resolves `origin/<base>` through
      // this same export before it will score anything, so the one probe that
      // must succeed is that `rev-parse`; everything else keeps the
      // "ref absent" answer the tail expects.
      gitSpawn: (_cwd, ...args) =>
        args[0] === 'rev-parse' && `${args.at(-1)}`.startsWith('origin/')
          ? { status: 0, stdout: 'deadbeefdeadbeef\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' },
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
      // Story #4542 — depth is derived inside runCodeReview from the diff, so
      // the review input MUST NOT carry a planner-authored risk envelope.
      seen.hasPlanningRisk = 'planningRisk' in opts;
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
      gitSpawnFn: gitSpawnStub(),
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      runCodeReviewFn,
      progress: () => {},
    });

    assert.deepEqual(seen.runReview, {
      scope: 'story',
      ticketId: 2839,
      baseRef: 'origin/main',
      headRef: 'story-2839',
      commentTargetId: 123,
    });
    assert.equal(
      seen.hasPlanningRisk,
      false,
      'Story-scope review input must not carry a planningRisk envelope (Story #4542)',
    );
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
      gitSpawnFn: gitSpawnStub(),
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

  it('never reads the story-plan-state checkpoint to resolve depth', async () => {
    // Story #4542: the close path used to load `planningRisk` off the Story's
    // checkpoint and thread it into the review depth. Depth is now derived from
    // the diff, so the review must not round-trip the ticket for it at all —
    // and must not resurrect the envelope even when a legacy checkpoint with
    // risk fields is still sitting on the issue.
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    let commentsRead = false;
    recorder.provider.getTicketComments = async () => {
      commentsRead = true;
      return [
        {
          body: [
            '<!-- ap:structured-comment type="story-plan-state" -->',
            '### story-plan-state',
            '',
            '```json',
            JSON.stringify({
              version: 2,
              storyId: 2839,
              planningRisk: { overallLevel: 'high', axes: [] },
            }),
            '```',
          ].join('\n'),
        },
      ];
    };
    let seenOpts = null;
    await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      gitSpawnFn: gitSpawnStub(),
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      runCodeReviewFn: async (opts) => {
        seenOpts = opts;
        return {
          severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
          posted: false,
          halted: false,
        };
      },
      progress: () => {},
    });
    assert.equal(commentsRead, false, 'no checkpoint read on the depth path');
    assert.equal('planningRisk' in seenOpts, false);
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
      gitSpawnFn: gitSpawnStub(),
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
      gitSpawnFn: gitSpawnStub(),
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

describe('shared base ref (Story #5325)', () => {
  const STORY_FILE = '.agents/scripts/lib/orchestration/code-review.js';
  const FOREIGN_FILE = 'docs/someone-elses-landed-change.md';

  /** Records what the review was handed, plus a clean envelope. */
  function recordingReview(seen) {
    return async (opts) => {
      seen.baseRef = opts.baseRef;
      seen.changedFiles = opts.changedFiles;
      return {
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: true,
        postedCommentId: 9001,
        commentTargetId: opts.commentTargetId,
        halted: false,
        blockerReason: null,
      };
    };
  }

  it('diffs against the remote base ref base-sync merged from, and says so', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    const seen = {};
    const lines = [];
    await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      gitSpawnFn: gitSpawnStub({
        diff: { 'origin/main...story-2839': [STORY_FILE] },
      }),
      runCodeReviewFn: recordingReview(seen),
      progress: (_tag, msg) => lines.push(msg),
    });

    assert.equal(seen.baseRef, 'origin/main');
    // AC-3: the progress line names the ref the diff actually used.
    assert.ok(
      lines.some((m) => m.includes('origin/main...story-2839')),
      'the REVIEW progress line names the resolved base ref',
    );
  });

  it('a local base branch behind its remote does not widen the reviewed file set', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    const seen = {};
    await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      // The defect's exact shape: local `main` is behind `origin/main`, so
      // diffing the bare branch name drags in a file someone else landed.
      gitSpawnFn: gitSpawnStub({
        diff: {
          'main...story-2839': [FOREIGN_FILE, STORY_FILE],
          'origin/main...story-2839': [STORY_FILE],
        },
      }),
      runCodeReviewFn: recordingReview(seen),
      progress: () => {},
    });

    assert.deepEqual(
      seen.changedFiles,
      [STORY_FILE],
      "the review scores the Story's own change set, not the stale local diff",
    );
    assert.ok(
      !seen.changedFiles.includes(FOREIGN_FILE),
      'a commit this Story never made must not reach the review',
    );
  });

  it('records a degradation and raises nothing when the remote base cannot be resolved', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    let reviewRan = false;
    const lines = [];
    const out = await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      // `--skip-sync`, or a checkout with no origin: nothing fetched the ref.
      gitSpawnFn: gitSpawnStub({
        resolveBase: false,
        diff: { 'main...story-2839': [FOREIGN_FILE, STORY_FILE] },
      }),
      runCodeReviewFn: async () => {
        reviewRan = true;
        return { halted: false };
      },
      progress: (_tag, msg) => lines.push(msg),
    });

    assert.equal(reviewRan, false, 'nothing is scored against the local ref');
    assert.equal(out.halted, false);
    assert.equal(out.severity.critical, 0);
    assert.equal(out.degraded, true);
    assert.deepEqual(out.degradations, [
      {
        tool: 'story-scope-review',
        gate: 'base-ref-resolution',
        surface: 'origin/main',
        reason: 'remote-base-ref-unresolved',
      },
    ]);
    assert.equal(recorder.postedComments.length, 0);
    assert.ok(
      lines.some((m) => m.includes('origin/main')),
      'the operator is told which ref could not be resolved',
    );
  });
});

describe('Story-scope lens pass retired (Story #5416)', () => {
  it('writes no lens prompt artifacts, prints no lens roster, and drops localLensReview', async () => {
    const { runStoryScopeReview } = await import(SUT_URL);
    const recorder = fakeProviderRecorder();
    const lines = [];
    const out = await runStoryScopeReview({
      cwd: '/repo',
      storyId: 2839,
      storyBranch: 'story-2839',
      baseBranch: 'main',
      gitSpawnFn: gitSpawnStub({
        diff: { 'origin/main...story-2839': ['lib/util.js'] },
      }),
      prUrl: 'https://github.com/owner/repo/pull/123',
      prNumber: 123,
      provider: recorder.provider,
      runCodeReviewFn: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        posted: true,
        postedCommentId: 9001,
        commentTargetId: 123,
        halted: false,
        blockerReason: null,
      }),
      progress: (_tag, msg) => lines.push(msg),
    });

    assert.equal('localLensReview' in out, false, 'envelope drops the field');
    assert.ok(
      !lines.some((m) => /lens prompts materialized|audit-story-/i.test(m)),
      `no lens roster or artifact line, got ${JSON.stringify(lines)}`,
    );
  });

  it('ships no close-time lens module', () => {
    const lensModule = path.resolve(
      REPO_ROOT,
      '.agents/scripts/lib/orchestration/story-close/phases/local-lens-review.js',
    );
    assert.equal(existsSync(lensModule), false);
  });
});

describe('tool-execution degradations route to friction telemetry (Story #4699, AC-4)', () => {
  it('buildLintFindings emits zero findings for an executionFailed summary', async () => {
    const { buildLintFindings } = await import(
      pathToFileURL(
        path.resolve(
          REPO_ROOT,
          '.agents/scripts/lib/orchestration/review-providers/native.js',
        ),
      ).href
    );
    assert.deepEqual(
      buildLintFindings({
        errors: 0,
        warnings: 0,
        executionFailed: true,
        skipped: false,
        mode: 'changed-only',
      }),
      [],
    );
  });

  it('a review run whose lint tool cannot execute records friction and zero findings', async () => {
    const { createNativeProvider } = await import(
      pathToFileURL(
        path.resolve(
          REPO_ROOT,
          '.agents/scripts/lib/orchestration/review-providers/native.js',
        ),
      ).href
    );
    const frictionCalls = [];
    const provider = createNativeProvider({
      gitSpawnFn: (_cwd, sub) =>
        sub === 'diff'
          ? { status: 0, stdout: 'README.md\n', stderr: '' }
          : { status: 0, stdout: '', stderr: '' },
      runScopedLintFn: () => ({
        errors: 0,
        warnings: 0,
        parsed: false,
        executionFailed: true,
        skipped: false,
        mode: 'changed-only',
      }),
      analyzeChangedFilesFn: async () => ({
        totalFiles: 1,
        jsFiles: 0,
        maintainability: [],
        criticalFindings: [],
        mediumFindings: [],
      }),
      emitToolDegradationFn: async (args) => {
        frictionCalls.push(args);
        return true;
      },
    });

    const findings = await provider.runReview({
      scope: 'story',
      ticketId: 4699,
      baseRef: 'main',
      headRef: 'story-4699',
    });

    assert.deepEqual(findings, [], 'zero findings in the severity tiers');
    assert.equal(frictionCalls.length, 1, 'friction telemetry recorded');
    assert.equal(frictionCalls[0].category, 'tool-degraded');
    assert.equal(frictionCalls[0].storyId, 4699);
  });
});

describe('runSingleStoryClose review-halt orchestration', () => {
  it('throws non-zero when the Story-scope review reports critical findings and skips auto-merge', async (t) => {
    if (typeof t.mock?.module !== 'function') {
      // Module mocking needs `--experimental-test-module-mocks`, which the
      // canonical `npm test` runner (run-tests.js) supplies. A bare
      // `node --test` invocation of this file (the Story verify[] shape)
      // cannot exercise this case — skip instead of failing on a harness
      // flag; the case still runs in the full suite and CI.
      t.skip(
        'module mocking unavailable without --experimental-test-module-mocks',
      );
      return;
    }
    const ghCalls = [];
    const gh = makeFakeGh((args) => {
      ghCalls.push(args.slice());
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/444\n';
      }
      if (args[1] === 'merge') {
        throw new Error('gh merge must not run when review halts');
      }
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    });
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=halt`);
    const recorder = fakeProviderRecorder();
    await assert.rejects(
      runSingleStoryClose({
        storyId: 2839,
        noWaitForMerge: true,
        cwd: '/repo',
        skipValidation: true,
        skipSync: true,
        injectedProvider: recorder.provider,
        injectedConfig: fakeConfig(),
        injectedGh: gh,
        injectedRunCodeReview: async (opts) => {
          // Sanity: the closer must invoke with the canonical envelope.
          assert.equal(opts.scope, 'story');
          assert.equal(opts.baseRef, 'origin/main');
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
    // Story #4539 — routed through the canonical `transitionTicketState`
    // mutator (which also syncs the Projects v2 column) rather than a bare
    // label write, so assert the transition's meaning rather than the
    // mutator's payload shape.
    const lastUpdate = recorder.updates.at(-1);
    assert.equal(lastUpdate.ticketId, 2839);
    assert.deepEqual(lastUpdate.payload.labels.add, ['agent::blocked']);
    for (const cleared of ['agent::executing', 'agent::ready']) {
      assert.ok(
        lastUpdate.payload.labels.remove.includes(cleared),
        `the transition clears ${cleared}`,
      );
    }
    assert.match(
      recorder.postedComments.at(-1).payload.body,
      /Code review blocked delivery/,
    );
  });

  /**
   * The sanctioned override.
   *
   * The forced choice this replaces: on Story #5007 / PR #5022 a FALSE critical
   * blocker (an exempt-by-config schema module the ratchet correctly ignored)
   * halted close, and `--help` offered no flag that overrides a review verdict.
   * The only way to land was a hand-run `gh pr merge`, which bypasses the gate
   * with no record of what was overridden or why. The bar here: the override
   * arms auto-merge, never parks the Story at `agent::blocked`, and leaves a
   * trail on both the Story and the PR.
   */
  it('--override-review-block lands the PR, records the reason, and never blocks the Story', async (t) => {
    if (typeof t.mock?.module !== 'function') {
      t.skip(
        'module mocking unavailable without --experimental-test-module-mocks',
      );
      return;
    }
    const REASON =
      'exempt schema blob per gates.maintainability.ignoreGlobs; ratchet passed';
    const ghCalls = [];
    const gh = makeFakeGh((args) => {
      ghCalls.push(args.slice());
      if (args[1] === 'list') return [];
      if (args[1] === 'create') {
        return 'https://github.com/owner/repo/pull/555\n';
      }
      if (args[1] === 'merge') return '';
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    });
    t.mock.module(GIT_UTILS_URL, gitUtilsMock());
    mockCloseValidation(t, closeValidationMock());
    t.mock.module(WORKTREE_MANAGER_URL, worktreeManagerMock());

    const { runSingleStoryClose } = await import(`${SUT_URL}?t=override`);
    const recorder = fakeProviderRecorder();
    const outcome = await runSingleStoryClose({
      storyId: 2839,
      noWaitForMerge: true,
      cwd: '/repo',
      skipValidation: true,
      skipSync: true,
      overrideReviewBlock: REASON,
      injectedProvider: recorder.provider,
      injectedConfig: fakeConfig(),
      injectedGh: gh,
      injectedRunCodeReview: async () => ({
        status: 'ok',
        severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
        posted: true,
        postedCommentId: 9999,
        commentTargetId: 555,
        halted: true,
        blockerReason: '1 critical blocker(s)',
      }),
    });

    // The PR was armed — the whole point of the flag.
    assert.ok(
      ghCalls.find((c) => c[1] === 'merge'),
      'auto-merge must be armed when the blocker is overridden',
    );
    // The Story is proceeding, so it must NOT be parked at agent::blocked.
    for (const u of recorder.updates) {
      assert.equal(
        (u.payload?.labels?.add ?? []).includes('agent::blocked'),
        false,
        'an overridden run must never transition the Story to agent::blocked',
      );
    }
    // The trail: the reason is recorded verbatim, on the Story AND on the PR.
    const overrideRecords = recorder.postedComments.filter((c) =>
      /Code-review blocker overridden by operator/.test(c.payload.body),
    );
    assert.equal(
      overrideRecords.length,
      2,
      'the override is recorded on both the Story and the PR',
    );
    for (const record of overrideRecords) {
      assert.ok(record.payload.body.includes(REASON));
      assert.match(record.payload.body, /1 critical blocker\(s\)/);
    }
    assert.deepEqual(
      overrideRecords.map((c) => c.ticketId).sort((a, b) => a - b),
      [555, 2839].sort((a, b) => a - b),
    );
    // The envelope says `overridden`, never `passed` — the review DID fail.
    assert.equal(outcome.terminal.gates.codeReview, 'overridden');
  });

  it('a reasonless override is rejected before any phase runs', async () => {
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=override-bare`);
    await assert.rejects(
      runSingleStoryClose({
        storyId: 2839,
        cwd: '/repo',
        // A bare `--override-review-block` reaches the parser as `true`.
        overrideReviewBlock: true,
      }),
      /--override-review-block requires a reason of at least 12 characters/,
    );
  });
});
