/**
 * tests/single-story-close-review-overlap.test.js — Story #5473: the
 * Story-scope review runs concurrently with the close-validation gates.
 *
 * Two layers:
 *   - `review-overlap.js` + `runCloseValidationPhase` directly, through their
 *     injected seams (no module mocking, so a bare `node --test` runs them).
 *   - `runSingleStoryClose` end to end, with its git / validation / worktree
 *     collaborators module-mocked. Module mocking needs
 *     `--experimental-test-module-mocks`, which the canonical `npm test`
 *     runner supplies; a bare `node --test` skips that layer.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINES_GATE_NAMES as REAL_BASELINES_GATE_NAMES } from '../.agents/scripts/lib/close-validation/gates.js';
import { runCloseValidationPhase } from '../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js';
import {
  discardHeldReview,
  reviewAfterPrOpen,
  startHeldReview,
} from '../.agents/scripts/lib/orchestration/single-story-close/review-overlap.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  .replace(/\\/g, '/');
const moduleUrl = (rel) => pathToFileURL(path.resolve(REPO_ROOT, rel)).href;
const SUT_URL = moduleUrl('.agents/scripts/single-story-close.js');
const GIT_UTILS_URL = moduleUrl('.agents/scripts/lib/git-utils.js');
const GATES_URL = moduleUrl('.agents/scripts/lib/close-validation/gates.js');
const VALIDATION_RUNNER_URL = moduleUrl(
  '.agents/scripts/lib/close-validation/runner.js',
);
const WORKTREE_MANAGER_URL = moduleUrl(
  '.agents/scripts/lib/worktree-manager.js',
);

const PINNED_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const MOVED_SHA = 'ffffeeeeddddccccbbbbaaaa9999888877776666';
const PR_URL = 'https://github.com/owner/repo/pull/123';
const CLEAN = { critical: 0, high: 0, medium: 0, suggestion: 0 };

/** A deferred promise: `resolve` it from outside. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * `rev-parse` answers `origin/<base>` always, and the Story branch with the
 * next SHA from `branchShas` (the last one repeats).
 */
function gitSpawnStub({ branchShas = [PINNED_SHA] } = {}) {
  const shas = [...branchShas];
  const calls = [];
  const fn = (_cwd, ...args) => {
    calls.push(args);
    const miss = { status: 1, stdout: '', stderr: '' };
    if (args[0] !== 'rev-parse') return miss;
    const ref = `${args.at(-1)}`;
    if (ref.startsWith('origin/')) {
      return { status: 0, stdout: 'deadbeef\n', stderr: '' };
    }
    const sha = shas.length > 1 ? shas.shift() : shas[0];
    return sha ? { status: 0, stdout: `${sha}\n`, stderr: '' } : miss;
  };
  fn.calls = calls;
  return fn;
}

function recordingProvider() {
  const posted = [];
  const updates = [];
  let nextId = 7000;
  return {
    posted,
    updates,
    provider: {
      getTicket: async (id) => ({
        id,
        state: 'open',
        title: 'Overlap Story',
        body: '',
        labels: ['agent::executing'],
      }),
      updateTicket: async (ticketId, payload) => {
        updates.push({ ticketId, payload });
      },
      postComment: async (ticketId, payload) => {
        const id = nextId++;
        posted.push({ ticketId, payload, id });
        return { commentId: id };
      },
      getTicketComments: async () => [],
      deleteComment: async () => {},
    },
  };
}

/** A review double; `onCall` sees each opts bag. */
function reviewDouble({ severity = CLEAN, onCall = () => {} } = {}) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    await onCall(opts);
    return {
      status: 'ok',
      severity,
      report: `report for ${opts.headRef}`,
      posted: opts.deferPost ? false : true,
      postedCommentId: opts.deferPost ? null : 4242,
      commentTargetId: opts.commentTargetId ?? opts.ticketId,
      halted: severity.critical > 0,
      blockerReason: null,
    };
  };
  fn.calls = calls;
  return fn;
}

function overlapArgs(overrides = {}) {
  return {
    cwd: '/repo',
    storyId: 5473,
    storyBranch: 'story-5473',
    baseBranch: 'main',
    provider: recordingProvider().provider,
    progress: () => {},
    ...overrides,
  };
}

describe('startHeldReview (direct)', () => {
  it('pins the review to the Story branch HEAD SHA and posts nothing', async () => {
    const runCodeReviewFn = reviewDouble();
    const held = startHeldReview(
      overlapArgs({ runCodeReviewFn, gitSpawnFn: gitSpawnStub() }),
    );
    assert.equal(held.sha, PINNED_SHA);
    const settled = await held.settled;
    assert.equal(settled.ok, true);
    const [opts] = runCodeReviewFn.calls;
    assert.equal(opts.headRef, PINNED_SHA, 'reviews the SHA, not the ref');
    assert.equal(opts.baseRef, 'origin/main');
    assert.equal(opts.deferPost, true, 'computes without posting');
    assert.equal(opts.commentTargetId, undefined, 'no PR exists yet');
  });

  it('returns null when the Story branch cannot be resolved', () => {
    const runCodeReviewFn = reviewDouble();
    const held = startHeldReview(
      overlapArgs({
        runCodeReviewFn,
        gitSpawnFn: gitSpawnStub({ branchShas: [null] }),
      }),
    );
    assert.equal(held, null);
    assert.equal(runCodeReviewFn.calls.length, 0);
  });

  it('carries a thrown review as a settled failure — never an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const held = startHeldReview(
        overlapArgs({
          runCodeReviewFn: async () => {
            throw new Error('provider exploded');
          },
          gitSpawnFn: gitSpawnStub(),
        }),
      );
      // The close abandons it (validation failed first): nobody awaits it.
      discardHeldReview(held, 'validation failed', () => {});
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(unhandled, []);
      const settled = await held.settled;
      assert.equal(settled.ok, false);
      assert.match(settled.error.message, /provider exploded/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('reviewAfterPrOpen (direct)', () => {
  function afterPrArgs({ held, gitSpawnFn, runCodeReviewFn, recorder }) {
    const phases = [];
    const durations = [];
    const postCalls = [];
    return {
      phases,
      durations,
      postCalls,
      args: overlapArgs({
        held,
        prUrl: PR_URL,
        prNumber: 123,
        provider: recorder.provider,
        runCodeReviewFn,
        gitSpawnFn,
        setPhase: (phase, opts) => phases.push({ phase, opts }),
        recordDuration: (phase, ms) => durations.push({ phase, ms }),
        postReportFn: async (args) => {
          postCalls.push(args);
          return { posted: true, postedCommentId: 9100 };
        },
      }),
    };
  }

  it('posts the held report to the PR and cross-references the Story', async () => {
    const recorder = recordingProvider();
    const gitSpawnFn = gitSpawnStub();
    const runCodeReviewFn = reviewDouble();
    const held = startHeldReview(
      overlapArgs({ runCodeReviewFn, gitSpawnFn, provider: recorder.provider }),
    );
    const { args, phases, durations, postCalls } = afterPrArgs({
      held,
      gitSpawnFn,
      runCodeReviewFn,
      recorder,
    });
    const outcome = await reviewAfterPrOpen(args);

    assert.equal(runCodeReviewFn.calls.length, 1, 'no second review');
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].commentTargetId, 123, 'posts to the PR');
    assert.equal(postCalls[0].report, `report for ${PINNED_SHA}`);
    assert.equal(outcome.halted, false);
    assert.equal(outcome.posted, true);
    assert.equal(outcome.postedCommentId, 9100);
    assert.equal(outcome.crossRefPosted, true);
    assert.equal(recorder.posted[0].ticketId, 5473, 'Story cross-reference');
    assert.match(recorder.posted[0].payload.body, /issuecomment-9100/);
    // The phase is tagged for failure attribution but left untimed: the
    // review records its own wall time instead.
    assert.deepEqual(phases, [
      { phase: 'code-review', opts: { timed: false } },
    ]);
    assert.equal(durations.length, 1);
    assert.equal(durations[0].phase, 'code-review');
  });

  it('a surviving CRITICAL in the held result still halts', async () => {
    const recorder = recordingProvider();
    const gitSpawnFn = gitSpawnStub();
    const runCodeReviewFn = reviewDouble({
      severity: { ...CLEAN, critical: 2 },
    });
    const held = startHeldReview(
      overlapArgs({ runCodeReviewFn, gitSpawnFn, provider: recorder.provider }),
    );
    const { args } = afterPrArgs({
      held,
      gitSpawnFn,
      runCodeReviewFn,
      recorder,
    });
    const outcome = await reviewAfterPrOpen(args);
    assert.equal(outcome.halted, true);
    assert.equal(outcome.severity.critical, 2);
  });

  it('discards a held result whose SHA is no longer the pushed HEAD and reviews serially', async () => {
    const recorder = recordingProvider();
    const gitSpawnFn = gitSpawnStub({ branchShas: [PINNED_SHA, MOVED_SHA] });
    const runCodeReviewFn = reviewDouble();
    const held = startHeldReview(
      overlapArgs({ runCodeReviewFn, gitSpawnFn, provider: recorder.provider }),
    );
    await held.settled;
    const { args, phases, postCalls } = afterPrArgs({
      held,
      gitSpawnFn,
      runCodeReviewFn,
      recorder,
    });
    const lines = [];
    args.progress = (_tag, msg) => lines.push(msg);
    const outcome = await reviewAfterPrOpen(args);

    assert.equal(postCalls.length, 0, 'the stale report never posts');
    assert.equal(runCodeReviewFn.calls.length, 2, 'the review re-ran');
    const serial = runCodeReviewFn.calls[1];
    assert.equal(serial.headRef, 'story-5473', 'against the pushed branch');
    assert.equal(serial.commentTargetId, 123);
    assert.notEqual(serial.deferPost, true);
    assert.equal(outcome.postedCommentId, 4242);
    assert.deepEqual(phases, [{ phase: 'code-review', opts: undefined }]);
    assert.ok(lines.some((m) => /discarded/.test(m)));
  });

  it('re-throws a held review failure at the code-review phase', async () => {
    const recorder = recordingProvider();
    const gitSpawnFn = gitSpawnStub();
    const runCodeReviewFn = async () => {
      throw new Error('review provider down');
    };
    const held = startHeldReview(
      overlapArgs({ runCodeReviewFn, gitSpawnFn, provider: recorder.provider }),
    );
    const { args, phases, postCalls } = afterPrArgs({
      held,
      gitSpawnFn,
      runCodeReviewFn,
      recorder,
    });
    await assert.rejects(reviewAfterPrOpen(args), /review provider down/);
    assert.equal(phases.at(-1).phase, 'code-review');
    assert.equal(postCalls.length, 0);
  });
});

describe('runCloseValidationPhase onPreGateStepsDone', () => {
  it('fires after the pre-gate self-heal steps and before the gates run', async () => {
    const order = [];
    await runCloseValidationPhase({
      cwd: '/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyBranch: 'story-5473',
      storyId: 5473,
      progress: () => {},
      runPreGateSteps: async () => order.push('pre-gate'),
      onPreGateStepsDone: () => order.push('hook'),
      buildDefaultGates: () => [{ name: 'lint' }],
      runCloseValidation: async () => {
        order.push('gates');
        return { ok: true, failed: [] };
      },
      createGateLogSink: () => ({
        log: () => {},
        flush: async () => {},
        digest: () => '',
        replay: () => {},
      }),
    });
    assert.deepEqual(order, ['pre-gate', 'hook', 'gates']);
  });
});

// ---------------------------------------------------------------------------
// runSingleStoryClose, end to end.
// ---------------------------------------------------------------------------

let tempRoot;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-review-overlap-');
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function fakeConfig() {
  return {
    project: { baseBranch: 'main', commands: {}, paths: { tempRoot } },
    delivery: {
      worktreeIsolation: {
        enabled: true,
        root: '.no-such-worktree-root',
        reapOnSuccess: false,
      },
    },
  };
}

function makeFakeGh(events) {
  const handle = async (args) => {
    events.push(`gh ${args[1]}`);
    if (args[1] === 'list') return [];
    if (args[1] === 'create') {
      return { stdout: `${PR_URL}\n`, stderr: '', code: 0 };
    }
    if (args[1] === 'merge') return { stdout: '', stderr: '', code: 0 };
    throw new Error(`unexpected gh: ${args.join(' ')}`);
  };
  return {
    pr: {
      list: (flags = [], fields) =>
        handle(['pr', 'list', ...flags, '--json', (fields ?? []).join(',')]),
      create: (flags = []) => handle(['pr', 'create', ...flags]),
      merge: (id, flags = []) => handle(['pr', 'merge', String(id), ...flags]),
    },
  };
}

function mockCollaborators(t, { gitSpawn, runCloseValidation }) {
  t.mock.module(GIT_UTILS_URL, {
    namedExports: {
      getStoryBranch: (s) => `story-${Number(s)}`,
      gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
      gitFetchWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      gitPullWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      gitSpawn,
      createGitInterface: () => ({
        gitSync: () => '',
        gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
        gitFetchWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
        gitPullWithRetry: async () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    },
  });
  t.mock.module(GATES_URL, {
    namedExports: {
      BASELINES_GATE_NAMES: REAL_BASELINES_GATE_NAMES,
      buildDefaultGates: () => [{ name: 'lint' }],
    },
  });
  t.mock.module(VALIDATION_RUNNER_URL, {
    namedExports: { runCloseValidation },
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

function skipWithoutModuleMocks(t) {
  if (typeof t.mock?.module === 'function') return false;
  t.skip('module mocking unavailable without --experimental-test-module-mocks');
  return true;
}

function closeArgs({ recorder, events, runCodeReview, ...rest }) {
  return {
    storyId: 5473,
    cwd: '/repo',
    skipValidation: false,
    skipSync: true,
    noWaitForMerge: true,
    injectedProvider: recorder.provider,
    injectedConfig: fakeConfig(),
    injectedGh: makeFakeGh(events),
    injectedRunCodeReview: runCodeReview,
    ...rest,
  };
}

const prComments = (recorder) =>
  recorder.posted.filter((c) => c.ticketId === 123);

describe('runSingleStoryClose — review overlaps close-validation', () => {
  it('runs the review alongside the gates, then posts to the PR once it exists', async (t) => {
    if (skipWithoutModuleMocks(t)) return;
    const events = [];
    // Each side waits for the other to start: this only completes when the
    // review and the gates are genuinely in flight at the same time.
    const reviewStarted = deferred();
    const gatesStarted = deferred();
    mockCollaborators(t, {
      gitSpawn: gitSpawnStub(),
      runCloseValidation: async () => {
        events.push('gates start');
        gatesStarted.resolve();
        await reviewStarted.promise;
        await new Promise((r) => setTimeout(r, 150));
        events.push('gates end');
        return { ok: true, failed: [] };
      },
    });
    const runCodeReview = reviewDouble({
      onCall: async () => {
        events.push('review start');
        reviewStarted.resolve();
        await gatesStarted.promise;
        await new Promise((r) => setTimeout(r, 250));
        events.push('review end');
      },
    });
    const recorder = recordingProvider();
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=overlap-ok`);
    const { success, terminal } = await runSingleStoryClose(
      closeArgs({ recorder, events, runCodeReview }),
    );

    assert.equal(success, true);
    assert.equal(runCodeReview.calls.length, 1, 'one review, not two');
    assert.equal(runCodeReview.calls[0].headRef, PINNED_SHA);
    assert.equal(runCodeReview.calls[0].deferPost, true);
    assert.ok(
      events.indexOf('review start') < events.indexOf('gates end'),
      `review overlaps the gates: ${events.join(' → ')}`,
    );
    // Findings post only after the PR exists, to the PR.
    const [reviewComment] = prComments(recorder);
    assert.ok(reviewComment, 'the held report posts to the PR');
    assert.match(reviewComment.payload.body, new RegExp(PINNED_SHA));
    assert.ok(events.indexOf('gh create') < events.indexOf('gh merge'));
    // AC-6: the review's own wall time, which overlaps close-validation.
    const reviewSeconds = terminal.phaseDurations['code-review'];
    assert.equal(typeof reviewSeconds, 'number');
    assert.ok(reviewSeconds >= 0.2, `review wall time ${reviewSeconds}s`);
    assert.ok(terminal.phaseDurations['close-validation'] >= 0.1);
    const { validateTerminalEnvelope } = await import(
      '../.agents/scripts/lib/orchestration/story-deliver-terminal.js'
    );
    assert.equal(validateTerminalEnvelope(terminal).valid, true);
  });

  it('a validation failure posts nothing and leaves no unhandled rejection', async (t) => {
    if (skipWithoutModuleMocks(t)) return;
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const events = [];
    mockCollaborators(t, {
      gitSpawn: gitSpawnStub(),
      runCloseValidation: async () => ({
        ok: false,
        failed: [{ gate: { name: 'lint' }, status: 1 }],
      }),
    });
    const runCodeReview = async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('review blew up after validation failed');
    };
    const recorder = recordingProvider();
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=overlap-fail`);
    await assert.rejects(
      runSingleStoryClose(closeArgs({ recorder, events, runCodeReview })),
      (err) =>
        err.closeGate === 'lint' && err.closePhase === 'close-validation',
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(unhandled, []);
    assert.equal(prComments(recorder).length, 0);
    assert.equal(events.includes('gh create'), false, 'nothing was pushed');
  });

  it('a pending (lock-wait-expired) validation posts nothing', async (t) => {
    if (skipWithoutModuleMocks(t)) return;
    const events = [];
    mockCollaborators(t, {
      gitSpawn: gitSpawnStub(),
      runCloseValidation: async ({ log }) => {
        log('[full-suite-lock] ⌛ lock wait expired (waited 900s)');
        return { ok: false, failed: [{ gate: { name: 'test' }, status: 75 }] };
      },
    });
    const runCodeReview = reviewDouble();
    const recorder = recordingProvider();
    const { runSingleStoryClose } = await import(
      `${SUT_URL}?t=overlap-pending`
    );
    const { terminal } = await runSingleStoryClose(
      closeArgs({ recorder, events, runCodeReview }),
    );
    assert.equal(terminal.status, 'pending');
    assert.equal(prComments(recorder).length, 0);
    assert.equal(events.includes('gh create'), false);
  });

  it('a held CRITICAL blocks the arm; the override arms and records the reason on Story and PR', async (t) => {
    if (skipWithoutModuleMocks(t)) return;
    const critical = { ...CLEAN, critical: 1 };
    mockCollaborators(t, {
      gitSpawn: gitSpawnStub(),
      runCloseValidation: async () => ({ ok: true, failed: [] }),
    });
    const { runSingleStoryClose } = await import(
      `${SUT_URL}?t=overlap-critical`
    );

    const blockedEvents = [];
    const blocked = recordingProvider();
    await assert.rejects(
      runSingleStoryClose(
        closeArgs({
          recorder: blocked,
          events: blockedEvents,
          runCodeReview: reviewDouble({ severity: critical }),
        }),
      ),
      /reported 1 critical blocker/,
    );
    assert.equal(blockedEvents.includes('gh merge'), false, 'never armed');
    assert.equal(prComments(blocked).length, 1, 'findings still posted');

    const REASON = 'false positive: exempt generated schema module';
    const overriddenEvents = [];
    const overridden = recordingProvider();
    const { terminal } = await runSingleStoryClose(
      closeArgs({
        recorder: overridden,
        events: overriddenEvents,
        runCodeReview: reviewDouble({ severity: critical }),
        overrideReviewBlock: REASON,
      }),
    );
    assert.ok(overriddenEvents.includes('gh merge'), 'the override arms');
    const records = overridden.posted.filter((c) =>
      c.payload.body.includes(REASON),
    );
    assert.deepEqual(
      records.map((c) => c.ticketId).sort((a, b) => a - b),
      [123, 5473],
    );
    assert.equal(terminal.gates.codeReview, 'overridden');
  });

  it('a HEAD that moved before PR-open discards the held result and re-reviews the pushed tree', async (t) => {
    if (skipWithoutModuleMocks(t)) return;
    const events = [];
    mockCollaborators(t, {
      gitSpawn: gitSpawnStub({ branchShas: [PINNED_SHA, MOVED_SHA] }),
      runCloseValidation: async () => ({ ok: true, failed: [] }),
    });
    const runCodeReview = reviewDouble();
    const recorder = recordingProvider();
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=overlap-stale`);
    const { success } = await runSingleStoryClose(
      closeArgs({ recorder, events, runCodeReview }),
    );
    assert.equal(success, true);
    assert.equal(runCodeReview.calls.length, 2);
    assert.equal(runCodeReview.calls[1].headRef, 'story-5473');
    assert.equal(runCodeReview.calls[1].commentTargetId, 123);
    // The double reports its own post for the serial run; the held report
    // (rendered for PINNED_SHA) never reaches the PR.
    assert.equal(
      prComments(recorder).some((c) => c.payload.body.includes(PINNED_SHA)),
      false,
    );
  });

  it('--skip-validation keeps the serial review', async (t) => {
    if (skipWithoutModuleMocks(t)) return;
    const events = [];
    mockCollaborators(t, {
      gitSpawn: gitSpawnStub(),
      runCloseValidation: async () => {
        throw new Error('validation must not run');
      },
    });
    const runCodeReview = reviewDouble();
    const recorder = recordingProvider();
    const { runSingleStoryClose } = await import(`${SUT_URL}?t=overlap-skip`);
    await runSingleStoryClose(
      closeArgs({ recorder, events, runCodeReview, skipValidation: true }),
    );
    assert.equal(runCodeReview.calls.length, 1);
    assert.equal(runCodeReview.calls[0].headRef, 'story-5473');
    assert.equal(runCodeReview.calls[0].commentTargetId, 123);
  });
});
