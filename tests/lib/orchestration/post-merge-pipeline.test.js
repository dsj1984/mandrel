/**
 * post-merge-pipeline — verifies that the extracted post-merge sequencer
 * runs the default phases in order, threads collaborators correctly, keeps
 * going on per-phase failures, and surfaces phase output via the returned
 * state object.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  branchCleanupPhase,
  DEFAULT_POST_MERGE_PHASES,
  dashboardRefreshPhase,
  healthMonitorPhase,
  notificationPhase,
  runPostMergePipeline,
  tempCleanupPhase,
  ticketClosurePhase,
  worktreeReapPhase,
} from '../../../.agents/scripts/lib/orchestration/post-merge-pipeline.js';

function makeLogger() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error: (msg) => errors.push(msg),
    warn: (msg) => warnings.push(msg),
    info: () => {},
    debug: () => {},
  };
}

function captureProgress() {
  const events = [];
  const fn = (phase, msg) => events.push({ phase, msg });
  return { events, fn };
}

describe('runPostMergePipeline', () => {
  it('runs phases in order and merges stateKey return values into state', async () => {
    const calls = [];
    const phases = [
      {
        name: 'a',
        fn: () => {
          calls.push('a');
          return { localDeleted: true, remoteDeleted: true };
        },
        stateKey: 'branchCleanup',
      },
      {
        name: 'b',
        fn: () => {
          calls.push('b');
          return true;
        },
        stateKey: 'healthUpdated',
      },
      {
        name: 'c',
        fn: () => {
          calls.push('c');
        },
      },
    ];
    const state = await runPostMergePipeline({ logger: makeLogger() }, phases);
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.deepEqual(state.branchCleanup, {
      localDeleted: true,
      remoteDeleted: true,
    });
    assert.equal(state.healthUpdated, true);
  });

  it('continues after a phase throws and logs [phase=name]', async () => {
    const logger = makeLogger();
    const calls = [];
    const phases = [
      {
        name: 'first',
        fn: () => {
          calls.push('first');
          throw new Error('boom');
        },
        stateKey: 'first',
      },
      {
        name: 'second',
        fn: () => {
          calls.push('second');
          return 'ok';
        },
        stateKey: 'second',
      },
    ];
    const state = await runPostMergePipeline({ logger }, phases);
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(state.second, 'ok');
    assert.ok(
      logger.errors.some(
        (m) => m.includes('[phase=first]') && m.includes('boom'),
      ),
      `expected [phase=first] log, got: ${JSON.stringify(logger.errors)}`,
    );
  });

  it('uses fallback when a phase fails and stateKey is set', async () => {
    const logger = makeLogger();
    const phases = [
      {
        name: 'health',
        fn: () => {
          throw new Error('nope');
        },
        stateKey: 'healthUpdated',
        fallback: false,
      },
    ];
    const state = await runPostMergePipeline({ logger }, phases);
    assert.equal(state.healthUpdated, false);
  });

  it('seeds default state shape so consumers can destructure safely', async () => {
    const state = await runPostMergePipeline({ logger: makeLogger() }, []);
    assert.deepEqual(state.worktreeReap, {
      status: 'not-run',
      path: null,
      reason: null,
      method: null,
      pendingCleanup: null,
      branchDeleted: null,
      remoteBranchDeleted: null,
    });
    assert.deepEqual(state.branchCleanup, {
      localDeleted: false,
      remoteDeleted: false,
    });
    assert.deepEqual(state.ticketClosure, {
      closedTickets: [],
      cascadedTo: [],
      cascadeFailed: [],
    });
    assert.equal(state.healthUpdated, false);
    assert.equal(state.manifestUpdated, false);
  });

  it('exposes the canonical default phase order', () => {
    const names = DEFAULT_POST_MERGE_PHASES.map((p) => p.name);
    assert.deepEqual(names, [
      'worktree-reap',
      'branch-cleanup',
      'ticket-closure',
      'notification',
      'health-monitor',
      'dashboard-refresh',
      'temp-cleanup',
    ]);
  });
});

describe('branchCleanupPhase', () => {
  it('delegates to the injected branchCleanup helper with noVerify=true', async () => {
    const logger = makeLogger();
    const { events, fn } = captureProgress();
    const calls = [];
    const branchCleanup = (name, opts) => {
      calls.push({ name, opts });
      return {
        deleted: true,
        reason: 'deleted',
        local: { deleted: true, reason: 'deleted' },
        remote: { deleted: true, reason: 'deleted' },
      };
    };
    const result = await branchCleanupPhase({
      storyBranch: 'story-7',
      repoRoot: '/repo',
      logger,
      progress: fn,
      branchCleanup,
    });
    assert.deepEqual(result, {
      localDeleted: true,
      remoteDeleted: true,
      localReason: 'deleted',
      remoteReason: 'deleted',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'story-7');
    assert.equal(calls[0].opts.cwd, '/repo');
    assert.equal(calls[0].opts.noVerify, true);
    assert.ok(events.some((e) => e.msg.includes('Deleting story branch')));
    assert.equal(logger.errors.length, 0);
  });

  it('logs an error when the local delete fails', async () => {
    const logger = makeLogger();
    const branchCleanup = () => ({
      deleted: false,
      reason: 'partial',
      local: { deleted: false, reason: 'error', stderr: 'still checked out' },
      remote: { deleted: true, reason: 'deleted' },
    });
    const result = await branchCleanupPhase({
      storyBranch: 'story-7',
      repoRoot: '/repo',
      logger,
      progress: () => {},
      branchCleanup,
    });
    assert.equal(result.localDeleted, false);
    assert.equal(result.remoteDeleted, true);
    assert.ok(
      logger.errors.some(
        (m) => m.includes('still checked out') && m.includes('story-7'),
      ),
    );
  });

  it('reports remote-not-found as skipped (not deleted)', async () => {
    const logger = makeLogger();
    const { events, fn } = captureProgress();
    const branchCleanup = () => ({
      deleted: true,
      reason: 'deleted',
      local: { deleted: true, reason: 'deleted' },
      remote: { deleted: true, reason: 'not-found' },
    });
    await branchCleanupPhase({
      storyBranch: 'story-7',
      repoRoot: '/repo',
      logger,
      progress: fn,
      branchCleanup,
    });
    assert.ok(events.some((e) => e.msg.includes('not found')));
  });
});

describe('worktreeReapPhase', () => {
  function makeWmFactory(overrides = {}) {
    const calls = { reap: [], list: 0 };
    const wm = {
      reap: async (storyId, opts) => {
        calls.reap.push({ storyId, opts });
        return overrides.reap ?? { removed: true, path: '/wt/story-1' };
      },
      list: async () => {
        calls.list += 1;
        return overrides.list ?? [];
      },
    };
    return { factory: () => wm, calls };
  }

  it('no-ops when worktree isolation is disabled', async () => {
    const { factory, calls } = makeWmFactory();
    const { events, fn } = captureProgress();
    const result = await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: false } },
      storyId: 1,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger: makeLogger(),
      progress: fn,
      worktreeManagerFactory: factory,
    });
    assert.equal(calls.reap.length, 0);
    assert.equal(result.status, 'skipped-disabled');
    assert.ok(
      events.some(
        (e) =>
          e.phase === 'WORKTREE' && e.msg.includes('Skipping worktree reap'),
      ),
    );
  });

  it('no-ops when reapOnSuccess is false', async () => {
    const { factory, calls } = makeWmFactory();
    const { events, fn } = captureProgress();
    const result = await worktreeReapPhase({
      orchestration: {
        worktreeIsolation: { enabled: true, reapOnSuccess: false },
      },
      storyId: 1,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger: makeLogger(),
      progress: fn,
      worktreeManagerFactory: factory,
    });
    assert.equal(calls.reap.length, 0);
    assert.equal(result.status, 'skipped-config');
    assert.ok(
      events.some(
        (e) => e.phase === 'WORKTREE' && e.msg.includes('reapOnSuccess=false'),
      ),
    );
  });

  it('emits friction + OPERATOR ACTION on Windows lock-class reap failure', async () => {
    const { factory } = makeWmFactory({
      reap: {
        removed: false,
        reason: 'EBUSY: resource busy',
        path: '/wt/story-1',
      },
    });
    const logger = makeLogger();
    const emissions = [];
    const frictionEmitter = { emit: async (e) => emissions.push(e) };
    const result = await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger,
      progress: () => {},
      frictionEmitter,
      worktreeManagerFactory: factory,
    });
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].markerKey, 'reap-failure');
    assert.equal(result.status, 'failed');
    assert.ok(
      logger.errors.some((m) => m.includes('OPERATOR ACTION REQUIRED')),
    );
  });

  it('returns deferred-to-sweep when Stage 2 handoff is required', async () => {
    const { factory } = makeWmFactory({
      reap: {
        removed: false,
        reason: 'remove-failed: EBUSY',
        method: 'deferred-to-sweep',
        path: '/wt/story-1',
        pendingCleanup: { storyId: 1, branch: 'story-1' },
      },
    });
    const result = await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger: makeLogger(),
      progress: () => {},
      frictionEmitter: { emit: async () => {} },
      worktreeManagerFactory: factory,
    });
    assert.equal(result.status, 'deferred-to-sweep');
    assert.equal(result.method, 'deferred-to-sweep');
    assert.deepEqual(result.pendingCleanup, { storyId: 1, branch: 'story-1' });
  });

  it('does not raise OPERATOR ACTION for benign safety skips', async () => {
    const { factory } = makeWmFactory({
      reap: {
        removed: false,
        reason: 'uncommitted-changes',
        path: '/wt/story-1',
      },
    });
    const logger = makeLogger();
    const frictionEmitter = { emit: async () => {} };
    await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger,
      progress: () => {},
      frictionEmitter,
      worktreeManagerFactory: factory,
    });
    assert.equal(
      logger.errors.filter((m) => m.includes('OPERATOR ACTION REQUIRED'))
        .length,
      0,
    );
  });

  it('flags still-registered worktrees after reap', async () => {
    const { factory } = makeWmFactory({
      reap: { removed: true, path: '/wt/story-1' },
      list: [{ path: '/repo/.worktrees/story-1' }],
    });
    const logger = makeLogger();
    const emissions = [];
    const frictionEmitter = { emit: async (e) => emissions.push(e) };
    const result = await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger,
      progress: () => {},
      frictionEmitter,
      worktreeManagerFactory: factory,
    });
    assert.equal(result.status, 'still-registered');
    assert.ok(
      logger.errors.some(
        (m) =>
          m.includes('still registered') &&
          m.includes('/repo/.worktrees/story-1'),
      ),
    );
    assert.equal(emissions.length, 1);
  });
});

describe('ticketClosurePhase (smoke)', () => {
  it('returns closed/cascaded shape and uses injected provider', async () => {
    const transitions = [];
    const provider = {
      getTicket: async (id) => ({ id, labels: ['agent::executing'] }),
      transitionTicketState: async (id, state) => {
        transitions.push({ id, state });
      },
    };
    const ctx = {
      provider,
      tasks: [],
      storyId: 100,
      notify: null,
      progress: () => {},
      logger: makeLogger(),
    };
    const result = await ticketClosurePhase(ctx);
    assert.ok(Array.isArray(result.closedTickets));
    assert.ok(Array.isArray(result.cascadedTo));
    assert.ok(Array.isArray(result.cascadeFailed));
  });
});

describe('healthMonitorPhase / dashboardRefreshPhase / notificationPhase', () => {
  it('healthMonitorPhase invokes injected updater and returns true', async () => {
    let called = 0;
    const result = await healthMonitorPhase({
      epicId: 9,
      progress: () => {},
      updateHealthFn: async () => {
        called += 1;
      },
    });
    assert.equal(result, true);
    assert.equal(called, 1);
  });

  it('dashboardRefreshPhase short-circuits when skipDashboard=true', async () => {
    let called = 0;
    const result = await dashboardRefreshPhase({
      epicId: 9,
      provider: {},
      skipDashboard: true,
      progress: () => {},
      generateManifestFn: async () => {
        called += 1;
      },
    });
    assert.equal(result, false);
    assert.equal(called, 0);
  });

  it('dashboardRefreshPhase invokes generator and returns true otherwise', async () => {
    let captured;
    const result = await dashboardRefreshPhase({
      epicId: 9,
      provider: { tag: 'p' },
      skipDashboard: false,
      progress: () => {},
      generateManifestFn: async (epicId, fresh, _arg, opts) => {
        captured = { epicId, fresh, opts };
      },
    });
    assert.equal(result, true);
    assert.equal(captured.epicId, 9);
    assert.equal(captured.fresh, true);
    assert.equal(captured.opts.provider.tag, 'p');
  });

  it('notificationPhase passes ticket count from state to the message', async () => {
    let captured;
    await notificationPhase(
      {
        epicId: 9,
        storyId: 100,
        story: { title: 'My Story' },
        epicBranch: 'epic/9',
        orchestration: {},
        progress: () => {},
        notifyFn: async (epicId, payload, opts) => {
          captured = { epicId, payload, opts };
        },
      },
      { ticketClosure: { closedTickets: [1, 2, 3] } },
    );
    assert.equal(captured.epicId, 9);
    assert.match(captured.payload.message, /Story #100/);
    assert.match(captured.payload.message, /3 ticket\(s\) closed/);
  });
});

describe('tempCleanupPhase', () => {
  it('sweeps per-Epic + legacy paths and ignores ENOENT', async () => {
    const attempted = [];
    await tempCleanupPhase({
      storyId: 100,
      epicId: 200,
      projectRoot: '/repo',
      progress: () => {},
      unlinkFn: async (p) => {
        attempted.push(p);
        // ENOENT on every path — none exist yet.
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });
    // Per-Epic: epic-200/story-100/manifest.{md,json} (2)
    // Legacy:   story-manifest-100.{md,json} (2)
    assert.equal(attempted.length, 4);
    assert.ok(
      attempted.some((p) =>
        p.replaceAll('\\', '/').endsWith('epic-200/story-100/manifest.md'),
      ),
    );
    assert.ok(
      attempted.some((p) =>
        p.replaceAll('\\', '/').endsWith('epic-200/story-100/manifest.json'),
      ),
    );
    assert.ok(attempted.some((p) => p.endsWith('story-manifest-100.md')));
    assert.ok(attempted.some((p) => p.endsWith('story-manifest-100.json')));
  });

  it('skips per-Epic targets when epicId is unknown', async () => {
    const attempted = [];
    await tempCleanupPhase({
      storyId: 100,
      projectRoot: '/repo',
      progress: () => {},
      unlinkFn: async (p) => {
        attempted.push(p);
      },
    });
    // No epicId → only legacy flat layout.
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((p) => !p.includes('epic-')));
  });
});
