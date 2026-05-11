/**
 * post-merge-pipeline — verifies that the extracted post-merge sequencer
 * runs the default phases in order, threads collaborators correctly, keeps
 * going on per-phase failures, and surfaces phase output via the returned
 * state object.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  branchCleanupPhase,
  DEFAULT_POST_MERGE_PHASES,
  dashboardRefreshPhase,
  notificationPhase,
  perfSummaryPhase,
  runPostMergePipeline,
  tempCleanupPhase,
  ticketClosurePhase,
  worktreeReapPhase,
} from '../../../.agents/scripts/lib/orchestration/post-merge-pipeline.js';

/**
 * Friction signals land on disk as NDJSON via
 * `signals-writer.appendSignal` (Epic #1030 Story #1042), which
 * resolves `temp/epic-<eid>/story-<sid>/signals.ndjson` relative to
 * `process.cwd()`. The reap-failure tests below switch cwd to a fresh
 * tmpdir so the asserted writes never collide with the repo's real
 * `temp/` tree.
 */
let prevCwd;
let workRoot;

function readFrictionSignals(epicId, storyId) {
  const p = path.join(
    workRoot,
    'temp',
    `epic-${epicId}`,
    `story-${storyId}`,
    'signals.ndjson',
  );
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

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
        stateKey: 'manifestUpdated',
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
    assert.equal(state.manifestUpdated, true);
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
        name: 'dashboard',
        fn: () => {
          throw new Error('nope');
        },
        stateKey: 'manifestUpdated',
        fallback: false,
      },
    ];
    const state = await runPostMergePipeline({ logger }, phases);
    assert.equal(state.manifestUpdated, false);
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
    assert.equal(state.manifestUpdated, false);
  });

  it('exposes the canonical default phase order', () => {
    const names = DEFAULT_POST_MERGE_PHASES.map((p) => p.name);
    assert.deepEqual(names, [
      'worktree-reap',
      'branch-cleanup',
      'ticket-closure',
      'notification',
      'dashboard-refresh',
      'temp-cleanup',
      'perf-summary',
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
  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'post-merge-pipeline-'));
    prevCwd = process.cwd();
    process.chdir(workRoot);
  });

  afterEach(() => {
    if (prevCwd) process.chdir(prevCwd);
    rmSync(workRoot, { recursive: true, force: true });
  });

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

  it('appends friction signal + OPERATOR ACTION on Windows lock-class reap failure', async () => {
    const { factory } = makeWmFactory({
      reap: {
        removed: false,
        reason: 'EBUSY: resource busy',
        path: '/wt/story-1',
      },
    });
    const logger = makeLogger();
    const result = await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicId: 9,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger,
      progress: () => {},
      worktreeManagerFactory: factory,
    });
    const signals = readFrictionSignals(9, 1);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, 'friction');
    assert.equal(signals[0].category, 'reap-failure');
    assert.equal(signals[0].epicId, 9);
    assert.equal(signals[0].storyId, 1);
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
      epicId: 9,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger: makeLogger(),
      progress: () => {},
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
    await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicId: 9,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger,
      progress: () => {},
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
    const result = await worktreeReapPhase({
      orchestration: { worktreeIsolation: { enabled: true } },
      storyId: 1,
      epicId: 9,
      epicBranch: 'epic/9',
      repoRoot: '/repo',
      logger,
      progress: () => {},
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
    const signals = readFrictionSignals(9, 1);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'reap-failure');
  });

  it('routes reap-failure friction through the ctx.config tempRoot (regression: leakage to process.cwd())', async () => {
    // Configure an *absolute* tempRoot pointing at a sibling of the
    // process.cwd() (workRoot). If the pipeline ever falls back to
    // resolving the relative 'temp' string against process.cwd() again,
    // the signal would land under `workRoot/temp/...` and the assertion
    // on the configured location would find an empty file — failing this
    // test red. This locks the contract that emitReapFailureFriction
    // forwards `config` to appendSignal.
    const configuredTempRoot = mkdtempSync(
      path.join(tmpdir(), 'post-merge-tempRoot-'),
    );
    try {
      const { factory } = makeWmFactory({
        reap: {
          removed: false,
          reason: 'EBUSY: resource busy',
          path: '/wt/story-1',
        },
      });
      await worktreeReapPhase({
        orchestration: { worktreeIsolation: { enabled: true } },
        storyId: 1,
        epicId: 9,
        epicBranch: 'epic/9',
        repoRoot: '/repo',
        logger: makeLogger(),
        progress: () => {},
        worktreeManagerFactory: factory,
        config: {
          agentSettings: { paths: { tempRoot: configuredTempRoot } },
        },
      });

      const configuredPath = path.join(
        configuredTempRoot,
        'epic-9',
        'story-1',
        'signals.ndjson',
      );
      assert.ok(
        existsSync(configuredPath),
        `friction signal should land under ctx.config.agentSettings.paths.tempRoot (${configuredPath})`,
      );

      const leakedPath = path.join(
        workRoot,
        'temp',
        'epic-9',
        'story-1',
        'signals.ndjson',
      );
      assert.equal(
        existsSync(leakedPath),
        false,
        `friction signal must NOT fall back to process.cwd()/temp (${leakedPath}) — that path is the regression tripwire`,
      );
    } finally {
      rmSync(configuredTempRoot, { recursive: true, force: true });
    }
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

describe('dashboardRefreshPhase / notificationPhase', () => {
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
    const captured = [];
    await notificationPhase(
      {
        epicId: 9,
        storyId: 100,
        story: { title: 'My Story' },
        epicBranch: 'epic/9',
        orchestration: {},
        progress: () => {},
        notifyFn: async (epicId, payload, opts) => {
          captured.push({ epicId, payload, opts });
        },
      },
      { ticketClosure: { closedTickets: [1, 2, 3] } },
    );
    // First fire is the story-merged comment + webhook; no provider was
    // passed so the rolled-up epic-progress fire is suppressed.
    assert.equal(captured.length, 1);
    assert.equal(captured[0].epicId, 9);
    assert.match(captured[0].payload.message, /Story #100/);
    assert.match(captured[0].payload.message, /3 ticket\(s\) closed/);
    assert.equal(captured[0].payload.event, 'story-merged');
  });

  it('notificationPhase fires a rolled-up epic-progress webhook when provider is available', async () => {
    const captured = [];
    const provider = {
      async getSubTickets() {
        return [
          { id: 100, state: 'closed', labels: ['type::story'] },
          { id: 101, state: 'closed', labels: ['type::story'] },
          { id: 102, state: 'open', labels: ['type::story'] },
          // Non-story descendants must NOT count toward the rollup.
          { id: 200, state: 'closed', labels: ['type::task'] },
          { id: 201, state: 'open', labels: ['type::task'] },
        ];
      },
    };
    await notificationPhase(
      {
        epicId: 9,
        storyId: 100,
        story: { title: 'My Story' },
        epicBranch: 'epic/9',
        orchestration: {},
        progress: () => {},
        provider,
        notifyFn: async (epicId, payload, opts) => {
          captured.push({ epicId, payload, opts });
        },
      },
      { ticketClosure: { closedTickets: [1, 2, 3] } },
    );
    // Two fires now: the per-story `story-merged` comment + the rolled-up
    // epic-progress webhook (suppressed comment).
    assert.equal(captured.length, 2);
    assert.equal(captured[0].payload.event, 'story-merged');
    assert.equal(captured[1].payload.event, 'epic-progress');
    assert.equal(captured[1].opts?.skipComment, true);
    assert.match(captured[1].payload.message, /2\/3 stories done/);
    assert.match(captured[1].payload.message, /67%/);
    assert.match(captured[1].payload.message, /Story #100 merged/);
  });

  it('notificationPhase swallows provider errors during the rolled-up fire (story-merged still fires)', async () => {
    const captured = [];
    const provider = {
      async getSubTickets() {
        throw new Error('GitHub 503');
      },
    };
    await notificationPhase(
      {
        epicId: 9,
        storyId: 100,
        story: { title: 'My Story' },
        epicBranch: 'epic/9',
        orchestration: {},
        progress: () => {},
        provider,
        notifyFn: async (epicId, payload, opts) => {
          captured.push({ epicId, payload, opts });
        },
        logger: { warn: () => {} },
      },
      { ticketClosure: { closedTickets: [] } },
    );
    // Only the story-merged fire — the rolled-up epic-progress was
    // swallowed when the provider threw.
    assert.equal(captured.length, 1);
    assert.equal(captured[0].payload.event, 'story-merged');
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

describe('perfSummaryPhase', () => {
  it('shells out to analyze-execution.js with story/epic/phase-timings flags', async () => {
    const calls = [];
    const spawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return Buffer.from('');
    };
    const result = await perfSummaryPhase({
      storyId: 100,
      epicId: 200,
      phaseTimingsPath: '/repo/temp/epic-200/story-100/phase-timings.json',
      projectRoot: '/repo',
      progress: () => {},
      logger: makeLogger(),
      spawnFn,
    });
    assert.equal(result.status, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, process.execPath);
    const { args } = calls[0];
    // First arg is the analyzer script path
    assert.ok(
      args[0]
        .replaceAll('\\', '/')
        .endsWith('.agents/scripts/analyze-execution.js'),
      `expected analyzer path, got: ${args[0]}`,
    );
    // Then the flag pairs
    assert.equal(args[1], '--story');
    assert.equal(args[2], '100');
    assert.equal(args[3], '--epic');
    assert.equal(args[4], '200');
    assert.equal(args[5], '--phase-timings');
    assert.equal(args[6], '/repo/temp/epic-200/story-100/phase-timings.json');
  });

  it('skips when phaseTimingsPath is missing (returns status=skipped)', async () => {
    let invoked = 0;
    const result = await perfSummaryPhase({
      storyId: 100,
      epicId: 200,
      phaseTimingsPath: null,
      projectRoot: '/repo',
      progress: () => {},
      logger: makeLogger(),
      spawnFn: () => {
        invoked += 1;
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(invoked, 0);
  });

  it('logs warn + returns status=failed when the analyzer throws', async () => {
    const logger = makeLogger();
    const spawnFn = () => {
      throw new Error('ENOENT analyze-execution.js');
    };
    const result = await perfSummaryPhase({
      storyId: 100,
      epicId: 200,
      phaseTimingsPath: '/repo/temp/epic-200/story-100/phase-timings.json',
      projectRoot: '/repo',
      progress: () => {},
      logger,
      spawnFn,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /ENOENT/);
    assert.ok(
      logger.warnings.some((m) => m.includes('analyze-execution failed')),
      `expected warn log, got: ${JSON.stringify(logger.warnings)}`,
    );
  });
});
