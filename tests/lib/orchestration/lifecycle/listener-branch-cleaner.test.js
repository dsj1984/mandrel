// tests/lib/orchestration/lifecycle/listener-branch-cleaner.test.js
/**
 * Unit tests for the lifecycle BranchCleaner listener (Story #2398).
 *
 * Acceptance contract:
 *   - Subscribes to `epic.cleanup.start` (and ONLY that event).
 *   - Reads the `epic-run-state` checkpoint via the injected
 *     `checkpointer.read()`, then delegates to `reapEpicBranches()`.
 *   - Classifies every observed `epic.cleanup.start` (`reaped`,
 *     `no-state`, `failed`, `skipped-duplicate`).
 *   - Listener-level idempotency: repeat `(event, seqId)` emits no
 *     side effects and records `skipped-duplicate`.
 *   - Constructor throws on malformed inputs (bus, epicId, checkpointer,
 *     cwd) per orchestration-error-handling.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  BranchCleaner,
  createBranchCleaner,
  summarizeReap,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/branch-cleaner.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a deterministic `gitSpawn` stub keyed off `(cmd, args)`. Every
 * git subcommand the BranchCleaner / reapEpicBranches() path runs
 * returns `{ status: 0 }` by default; tests override specific calls by
 * pushing to `overrides`.
 */
function makeGitSpawn({ overrides = [], log } = {}) {
  return (cwd, ...args) => {
    log?.push({ cwd, args });
    for (const o of overrides) {
      if (o.match(args)) return o.result;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function makeCheckpointer(state) {
  return {
    read: async () => state,
  };
}

describe('BranchCleaner — constructor guards', () => {
  const validOpts = {
    bus: new Bus(),
    epicId: 42,
    checkpointer: makeCheckpointer({ epicId: 42 }),
    cwd: '/tmp/x',
    logger: quietLogger(),
  };

  it('throws when bus is missing', () => {
    assert.throws(() => new BranchCleaner({ ...validOpts, bus: null }), {
      name: 'TypeError',
      message: /bus/,
    });
  });

  it('throws when epicId is not a positive integer', () => {
    assert.throws(() => new BranchCleaner({ ...validOpts, epicId: 0 }), {
      name: 'TypeError',
      message: /epicId/,
    });
    assert.throws(() => new BranchCleaner({ ...validOpts, epicId: 'forty' }), {
      name: 'TypeError',
    });
  });

  it('throws when checkpointer lacks read()', () => {
    assert.throws(() => new BranchCleaner({ ...validOpts, checkpointer: {} }), {
      name: 'TypeError',
      message: /checkpointer/,
    });
  });

  it('throws on empty cwd', () => {
    assert.throws(() => new BranchCleaner({ ...validOpts, cwd: '' }), {
      name: 'TypeError',
      message: /cwd/,
    });
  });

  it('subscribes to epic.cleanup.start and only that event', () => {
    const cleaner = new BranchCleaner(validOpts);
    assert.deepEqual(cleaner.events, ['epic.cleanup.start']);
  });

  it('createBranchCleaner is a thin factory', () => {
    const inst = createBranchCleaner(validOpts);
    assert.ok(inst instanceof BranchCleaner);
  });
});

describe('BranchCleaner — handle()', () => {
  function buildHarness({ state, gitSpawnLog = [], gitOverrides = [] } = {}) {
    const bus = new Bus();
    const checkpointer = makeCheckpointer(state ?? null);
    const cleaner = new BranchCleaner({
      bus,
      epicId: state?.epicId ?? 42,
      checkpointer,
      cwd: '/repo',
      gitSpawn: makeGitSpawn({ overrides: gitOverrides, log: gitSpawnLog }),
      rmSyncFn: () => {},
      logger: quietLogger(),
    });
    return { bus, cleaner, gitSpawnLog };
  }

  it('records no-state when the checkpoint is null', async () => {
    const { cleaner } = buildHarness({ state: null });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 1 });
    const last = cleaner.classifications.at(-1);
    assert.equal(last.outcome, 'no-state');
  });

  it('records no-state when the checkpoint has no epicId', async () => {
    const { cleaner } = buildHarness({ state: { waves: [] } });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 2 });
    assert.equal(cleaner.classifications.at(-1).outcome, 'no-state');
  });

  it('reaps the epic + story branches when the checkpoint is populated', async () => {
    const state = {
      epicId: 42,
      waves: [
        { stories: [{ id: 100 }, { id: 101 }] },
        { stories: [{ id: 102 }] },
      ],
    };
    const log = [];
    const { cleaner } = buildHarness({ state, gitSpawnLog: log });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 3 });
    const last = cleaner.classifications.at(-1);
    assert.equal(last.outcome, 'reaped');
    assert.equal(last.epicId, 42);
    assert.equal(last.branchesDeleted, 4); // 3 stories + 1 epic (wt-branch is a separate sweep)
    // Every story-id and the epic ref appears in a `branch -D` call,
    // plus the `wt-branch` scratch-ref sweep tail.
    const deletes = log
      .filter((c) => c.args[0] === 'branch' && c.args[1] === '-D')
      .map((c) => c.args[2]);
    assert.deepEqual(
      deletes.sort(),
      ['epic/42', 'story-100', 'story-101', 'story-102', 'wt-branch'].sort(),
    );
    assert.equal(last.wtBranchDeleted, true);
  });

  it('records failed when at least one branch reap fails', async () => {
    const state = { epicId: 7, waves: [{ stories: [{ id: 50 }] }] };
    const { cleaner } = buildHarness({
      state,
      gitOverrides: [
        {
          match: (args) =>
            args[0] === 'branch' && args[1] === '-D' && args[2] === 'story-50',
          result: { status: 128, stdout: '', stderr: 'pinned' },
        },
      ],
    });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 4 });
    const last = cleaner.classifications.at(-1);
    assert.equal(last.outcome, 'failed');
    assert.equal(last.reason, 'reap-failures');
    assert.equal(last.failures.length, 1);
    assert.equal(last.failures[0].branch, 'story-50');
    assert.equal(last.failures[0].stderr, 'pinned');
  });

  it('records skipped-duplicate on a replayed (event, seqId)', async () => {
    const state = { epicId: 1, waves: [{ stories: [{ id: 9 }] }] };
    const { cleaner } = buildHarness({ state });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 5 });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 5 });
    assert.equal(cleaner.classifications.length, 2);
    assert.equal(cleaner.classifications[0].outcome, 'reaped');
    assert.equal(cleaner.classifications[1].outcome, 'skipped-duplicate');
  });

  it('records failed when the checkpointer throws', async () => {
    const bus = new Bus();
    const cleaner = new BranchCleaner({
      bus,
      epicId: 11,
      checkpointer: {
        read: async () => {
          throw new Error('rate-limited');
        },
      },
      cwd: '/repo',
      gitSpawn: makeGitSpawn(),
      rmSyncFn: () => {},
      logger: quietLogger(),
    });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 6 });
    const last = cleaner.classifications.at(-1);
    assert.equal(last.outcome, 'failed');
    assert.ok(/checkpoint-read-failed/.test(last.reason));
  });

  it('reset() clears the idempotency cache and classifications', async () => {
    const state = { epicId: 1, waves: [{ stories: [{ id: 1 }] }] };
    const { cleaner } = buildHarness({ state });
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 7 });
    assert.equal(cleaner.classifications.length, 1);
    cleaner.reset();
    assert.equal(cleaner.classifications.length, 0);
    await cleaner.handle({ event: 'epic.cleanup.start', seqId: 7 });
    assert.equal(cleaner.classifications.at(-1).outcome, 'reaped');
  });
});

describe('summarizeReap', () => {
  it('counts branchesDeleted, worktreesRemoved, tracksPruned, wtBranchDeleted', () => {
    const sum = summarizeReap({
      reaped: [
        {
          branch: 'a',
          branchDeleted: true,
          worktreeReaped: true,
          method: 'worktree-remove',
        },
        {
          branch: 'b',
          branchDeleted: true,
          worktreeReaped: true,
          method: 'no-worktree',
        },
        {
          branch: 'c',
          branchDeleted: false,
          worktreeReaped: false,
          method: 'unknown',
        },
      ],
      pruned: { pruned: ['origin/foo', 'origin/bar'] },
      wtBranch: { deleted: true },
    });
    assert.equal(sum.branchesDeleted, 2);
    assert.equal(sum.worktreesRemoved, 1);
    assert.equal(sum.tracksPruned, 2);
    assert.equal(sum.wtBranchDeleted, true);
  });

  it('handles undefined fields safely', () => {
    const sum = summarizeReap({});
    assert.equal(sum.branchesDeleted, 0);
    assert.equal(sum.worktreesRemoved, 0);
    assert.equal(sum.tracksPruned, 0);
    assert.equal(sum.wtBranchDeleted, false);
  });
});

describe('BranchCleaner — bus-driven activation', () => {
  it('fires on bus.emit("epic.cleanup.start") through the schema-validated emit', async () => {
    const state = { epicId: 99, waves: [{ stories: [{ id: 1 }] }] };
    const bus = new Bus();
    const cleaner = new BranchCleaner({
      bus,
      epicId: 99,
      checkpointer: makeCheckpointer(state),
      cwd: '/repo',
      gitSpawn: makeGitSpawn(),
      rmSyncFn: () => {},
      logger: quietLogger(),
    });
    cleaner.register();
    await bus.emit('epic.cleanup.start', { epicId: 99 });
    assert.equal(cleaner.classifications.length, 1);
    assert.equal(cleaner.classifications[0].outcome, 'reaped');
  });
});
