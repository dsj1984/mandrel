import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCloseoutArgv } from '../.agents/scripts/closeout-audit.js';
import {
  buildProbes,
  buildRepairs,
  buildWithLock,
  CHECKS,
  exitCodeFor,
  listMergedStoryIds,
  renderAudit,
  runCloseoutAudit,
  selectMergedStoryIds,
} from '../.agents/scripts/lib/orchestration/closeout-audit.js';
import { NEXT_COMMANDS } from '../.agents/scripts/lib/orchestration/story-deliver-terminal.js';

const HEAD = 'abc123';

function closedWorld(overrides = {}) {
  return {
    issueState: 'closed',
    label: 'agent::done',
    column: 'Done',
    boardError: null,
    remoteSha: null,
    local: false,
    worktreePath: null,
    scratch: [],
    merged: true,
    body: '',
    ...overrides,
  };
}

function probesFor(world) {
  return {
    ticket: async () => ({
      ok: true,
      issueState: world.issueState,
      stateLabel: world.label,
      labels: [world.label],
    }),
    pr: async () =>
      world.merged
        ? { number: 77, state: 'MERGED', headSha: HEAD, body: world.body }
        : { number: 77, state: 'OPEN' },
    board: async () =>
      world.boardError
        ? { ok: false, error: world.boardError }
        : { ok: true, column: world.column },
    branch: async () => ({
      local: world.local,
      worktreePath: world.worktreePath,
    }),
    remote: async () => ({ ok: true, sha: world.remoteSha }),
    scratch: async () => ({ paths: world.scratch }),
  };
}

function repairsFor(world, calls, refuse = {}) {
  const make = (check, fix) => async () => {
    calls.push(check);
    if (refuse[check]) return { ok: false, reason: refuse[check] };
    fix();
    return { ok: true };
  };
  return {
    'story-state': make('story-state', () => {
      world.issueState = 'closed';
      world.label = 'agent::done';
      world.local = false; // the land tail also reaps the local ref
    }),
    'board-status': make('board-status', () => {
      world.column = 'Done';
    }),
    'remote-branch': make('remote-branch', () => {
      world.remoteSha = null;
    }),
    'local-branch': make('local-branch', () => {
      world.local = false;
    }),
    worktree: make('worktree', () => {
      world.worktreePath = null;
    }),
    scratch: make('scratch', () => {
      world.scratch = [];
    }),
  };
}

const lockOk = async (fn) => ({ locked: true, value: await fn() });

async function audit(
  world,
  { execute = false, calls = [], refuse, withLock = lockOk } = {},
) {
  return runCloseoutAudit({
    storyIds: [42],
    scope: { mode: 'explicit' },
    probes: probesFor(world),
    repairs: repairsFor(world, calls, refuse),
    execute,
    withLock,
  });
}

const check = (env, name) =>
  env.stories[0].checks.find((c) => c.check === name);

describe('closeout-audit core', () => {
  it('AC-1: merged but still open reports story-state drift with confirm-merge, exit 2', async () => {
    const env = await audit(
      closedWorld({
        issueState: 'open',
        label: 'agent::closing',
        body: 'Coverage-deferred: ci-ratchet',
      }),
    );
    const row = check(env, 'story-state');
    assert.equal(row.status, 'drift');
    assert.equal(row.repair, NEXT_COMMANDS.confirmMerge(42));
    assert.match(row.evidence, /Coverage-deferred: ci-ratchet/);
    assert.equal(exitCodeFor(env), 2);
  });

  it('AC-3: leftovers each report their own drifted row naming the path or ref', async () => {
    const env = await audit(
      closedWorld({
        remoteSha: HEAD,
        local: true,
        worktreePath: '.worktrees/story-42',
        scratch: ['/t/story-42'],
      }),
    );
    assert.match(
      check(env, 'remote-branch').evidence,
      /origin\/story-42 at abc123/,
    );
    assert.match(check(env, 'local-branch').evidence, /refs\/heads\/story-42/);
    assert.equal(check(env, 'worktree').evidence, '.worktrees/story-42');
    assert.equal(check(env, 'scratch').evidence, '/t/story-42');
    for (const name of [
      'remote-branch',
      'local-branch',
      'worktree',
      'scratch',
    ]) {
      assert.equal(check(env, name).status, 'drift');
    }
  });

  it('AC-4: an unreachable board is unknown, never repaired, exit unaffected', async () => {
    const calls = [];
    const env = await audit(
      closedWorld({ boardError: 'no GraphQL transport' }),
      { execute: true, calls },
    );
    assert.equal(check(env, 'board-status').status, 'unknown');
    assert.deepEqual(calls, []);
    assert.equal(exitCodeFor(env), 0);
  });

  it('AC-5: execute repairs story-state first, re-probes, then the rest', async () => {
    const calls = [];
    const world = closedWorld({
      issueState: 'open',
      label: 'agent::closing',
      column: 'In Progress',
      local: true,
      scratch: ['/t/x'],
    });
    const env = await audit(world, { execute: true, calls });
    assert.deepEqual(calls, ['story-state', 'board-status', 'scratch']);
    assert.equal(check(env, 'story-state').repaired, true);
    assert.equal(check(env, 'local-branch').repaired, true);
    assert.equal(exitCodeFor(env), 0);
  });

  it('AC-5: a refused repair stays drifted with the refusal, exit 2', async () => {
    const env = await audit(
      closedWorld({ worktreePath: '.worktrees/story-42' }),
      {
        execute: true,
        refuse: { worktree: 'running-from-target-tree' },
      },
    );
    const row = check(env, 'worktree');
    assert.equal(row.status, 'drift');
    assert.match(row.evidence, /repair refused: running-from-target-tree/);
    assert.equal(exitCodeFor(env), 2);
  });

  it('a contended lock repairs nothing and says why', async () => {
    const calls = [];
    const env = await audit(closedWorld({ local: true }), {
      execute: true,
      calls,
      withLock: async () => ({ locked: false, reason: 'contended' }),
    });
    assert.deepEqual(calls, []);
    assert.match(check(env, 'local-branch').evidence, /sweep lock contended/);
  });

  it('AC-6: a closed-out Story is all ok, exit 0; a second execute changes nothing', async () => {
    const world = closedWorld({ remoteSha: HEAD });
    const first = await audit(world, { execute: true });
    assert.equal(exitCodeFor(first), 0);
    const calls = [];
    const second = await audit(world, { execute: true, calls });
    assert.deepEqual(calls, []);
    assert.ok(
      second.stories[0].checks.every((c) => c.status === 'ok' && !c.repaired),
    );
  });

  it('a Story with no merged PR is not landed: every check unknown', async () => {
    const env = await audit(closedWorld({ merged: false }));
    assert.ok(env.stories[0].checks.every((c) => c.status === 'unknown'));
    assert.equal(exitCodeFor(env), 0);
  });

  it('AC-7: one envelope, one entry per Story, one row per check', async () => {
    const env = await audit(closedWorld());
    assert.equal(env.kind, 'closeout-audit');
    assert.equal(env.stories.length, 1);
    assert.deepEqual(
      env.stories[0].checks.map((c) => c.check),
      CHECKS,
    );
    assert.equal(env.stories[0].readings, undefined);
    assert.equal(JSON.parse(JSON.stringify(env)).summary.ok, 6);
    assert.match(renderAudit(env), /Story #42 \(PR #77\)/);
  });
});

describe('closeout-audit scope', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const rows = [
    { headRefName: 'story-1', mergedAt: '2026-11-10T01:00:00Z' },
    { headRefName: 'story-2', mergedAt: '2026-11-08T01:00:00Z' },
    { headRefName: 'story-3-fix', mergedAt: '2026-11-10T01:00:00Z' },
    { headRefName: 'feature/story-4', mergedAt: '2026-11-10T01:00:00Z' },
    { headRefName: 'story-1', mergedAt: '2026-11-10T02:00:00Z' },
  ];

  it('AC-2: only exact story-<id> heads merged inside the window', () => {
    assert.deepEqual(
      selectMergedStoryIds(rows, { sinceHours: 24, nowMs: now }),
      [1],
    );
    assert.deepEqual(
      selectMergedStoryIds(rows, { sinceHours: 72, nowMs: now }),
      [1, 2],
    );
  });

  it('lists merged PRs against the base branch', async () => {
    let flags;
    const list = async (f) => {
      flags = f;
      return rows;
    };
    const gh = { pr: { list } };
    const ids = await listMergedStoryIds({
      gh,
      baseBranch: 'main',
      sinceHours: 24,
      nowMs: now,
    });
    assert.deepEqual(ids, [1]);
    assert.deepEqual(flags.slice(0, 4), [
      '--state',
      'merged',
      '--base',
      'main',
    ]);
  });
});

describe('closeout-audit live wiring (injected)', () => {
  it('remote probe reads ls-remote and reports a failure as unreadable', async () => {
    const ok = buildProbes({
      cwd: '/r',
      gitSpawnFn: () => ({
        status: 0,
        stdout: `${HEAD}\trefs/heads/story-5\n`,
      }),
    });
    assert.deepEqual(await ok.remote(5), { ok: true, sha: HEAD });
    const bad = buildProbes({
      cwd: '/r',
      gitSpawnFn: () => ({ status: 128, stderr: 'offline' }),
    });
    assert.deepEqual(await bad.remote(5), { ok: false, error: 'offline' });
  });

  it('board probe is unreadable without a GraphQL transport', async () => {
    const probes = buildProbes({ cwd: '/r', provider: {} });
    assert.equal((await probes.board(5)).ok, false);
  });

  it('scratch probe is a dry-run purge', async () => {
    let seen;
    const purgeFn = async (a) => {
      seen = a;
      return { purged: [{ path: '/t/story-5' }], errors: [] };
    };
    const probes = buildProbes({ cwd: '/r', purgeFn });
    assert.deepEqual(await probes.scratch(5), { paths: ['/t/story-5'] });
    assert.equal(seen.dryRun, true);
  });

  it('pr probe attaches the merged body', async () => {
    const gh = {
      pr: {
        list: async () => [
          { number: 9, state: 'MERGED', mergedAt: 'x', headRefOid: HEAD },
        ],
        view: async () => ({ body: 'Coverage-deferred: x' }),
      },
    };
    const pr = await buildProbes({ cwd: '/r', gh }).pr(5);
    assert.equal(pr.body, 'Coverage-deferred: x');
  });

  const entry = {
    storyId: 5,
    readings: { remote: { sha: HEAD }, pr: { headSha: HEAD } },
  };

  it('remote repair refuses a head pushed after the merge', async () => {
    const repairs = buildRepairs({
      cwd: '/r',
      deleteRemoteFn: () => assert.fail('must not delete'),
    });
    const res = await repairs['remote-branch']({
      ...entry,
      readings: { ...entry.readings, remote: { sha: 'zzz' } },
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not the merged head/);
  });

  it('remote repair deletes through deleteBranchRemote', async () => {
    const repairs = buildRepairs({
      cwd: '/r',
      deleteRemoteFn: (name) => ({ deleted: name === 'story-5' }),
    });
    assert.deepEqual(await repairs['remote-branch'](entry), { ok: true });
  });

  it('local repair reports the protection reason', async () => {
    const sweepBranchesFn = async (a) => {
      assert.deepEqual(a.include, ['story-5']);
      return {
        reaped: [],
        protected: [{ branch: 'story-5', reason: 'dirty-worktree' }],
      };
    };
    const repairs = buildRepairs({ cwd: '/r', provider: {}, sweepBranchesFn });
    assert.deepEqual(await repairs['local-branch'](entry), {
      ok: false,
      reason: 'dirty-worktree',
    });
  });

  it('worktree and scratch repairs read their seam results', async () => {
    const repairs = buildRepairs({
      cwd: '/r',
      sweepWorktreesFn: async () => ({
        reaped: [],
        skipped: [{ storyId: 5, reason: 'story-open' }],
      }),
      purgeFn: async () => ({ purged: [], errors: [] }),
    });
    assert.deepEqual(await repairs.worktree(entry), {
      ok: false,
      reason: 'story-open',
    });
    assert.deepEqual(await repairs.scratch(entry), { ok: true });
  });

  it('script repairs run the existing CLI and report a non-zero exit', async () => {
    const argvs = [];
    const spawnFn = (_bin, args) => {
      argvs.push(args);
      return { status: argvs.length === 1 ? 0 : 1 };
    };
    const repairs = buildRepairs({ cwd: '/r', spawnFn });
    assert.deepEqual(await repairs['story-state'](entry), { ok: true });
    assert.match(
      (await repairs['board-status'](entry)).reason,
      /resync-status-column\.js exited 1/,
    );
    assert.match(argvs[0][0], /single-story-confirm-merge\.js$/);
  });

  it('withLock releases the lock and reports contention', async () => {
    let released = false;
    const held = buildWithLock({
      cwd: '/r',
      acquireFn: () => ({
        acquired: true,
        release: () => {
          released = true;
        },
      }),
    });
    assert.deepEqual(await held(async () => 1), { locked: true, value: 1 });
    assert.equal(released, true);
    const busy = buildWithLock({
      cwd: '/r',
      acquireFn: () => ({ acquired: false, reason: 'contended' }),
    });
    assert.deepEqual(await busy(async () => 1), {
      locked: false,
      reason: 'contended',
    });
  });
});

describe('closeout-audit argv', () => {
  it('parses ids and defaults the window', () => {
    const a = parseCloseoutArgv([
      '--story',
      '1,2',
      '--execute',
      '--json',
      '--cwd',
      '/r',
    ]);
    assert.deepEqual(a, {
      storyIds: [1, 2],
      sinceHours: 24,
      execute: true,
      json: true,
      cwd: '/r',
    });
    assert.equal(parseCloseoutArgv(['--since-hours', '6']).sinceHours, 6);
  });

  it('rejects bad ids and windows', () => {
    assert.throws(
      () => parseCloseoutArgv(['--story', 'x']),
      /positive integer/,
    );
    assert.throws(
      () => parseCloseoutArgv(['--since-hours', '0']),
      /positive number/,
    );
  });
});
