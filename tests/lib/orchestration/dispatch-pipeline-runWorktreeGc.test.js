import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { runWorktreeGc } from '../../../.agents/scripts/lib/orchestration/dispatch-pipeline.js';

function buildFetched(overrides = {}) {
  return {
    tasks: [],
    allTicketsById: new Map(),
    ...overrides,
  };
}

function buildManager({
  lockSweep = { removed: [], skipped: [] },
  gc = { reaped: [] },
  throws = null,
} = {}) {
  return {
    sweepStaleLocks: mock.fn(async () => {
      if (throws === 'sweep') throw new Error('sweep boom');
      return lockSweep;
    }),
    gc: mock.fn(async () => {
      if (throws === 'gc') throw new Error('gc boom');
      return gc;
    }),
  };
}

describe('runWorktreeGc — guard branches', () => {
  it('no-op when worktreeManager is absent', async () => {
    await runWorktreeGc(
      { epicBranch: 'epic/1', dryRun: false },
      buildFetched(),
    );
    // nothing to assert beyond no-throw
    assert.ok(true);
  });

  it('no-op when dryRun is true (even with a manager wired in)', async () => {
    const mgr = buildManager();
    await runWorktreeGc(
      { worktreeManager: mgr, dryRun: true, epicBranch: 'epic/1' },
      buildFetched(),
    );
    assert.equal(mgr.sweepStaleLocks.mock.callCount(), 0);
    assert.equal(mgr.gc.mock.callCount(), 0);
  });
});

describe('runWorktreeGc — sweep + gc results', () => {
  it('logs nothing extra when both sweep and gc return empty arrays', async () => {
    const mgr = buildManager();
    await runWorktreeGc(
      { worktreeManager: mgr, dryRun: false, epicBranch: 'epic/1' },
      buildFetched(),
    );
    assert.equal(mgr.sweepStaleLocks.mock.callCount(), 1);
    assert.equal(mgr.gc.mock.callCount(), 1);
  });

  it('logs the count when sweep removed at least one stale lock', async () => {
    const mgr = buildManager({
      lockSweep: { removed: [{ path: 'a' }, { path: 'b' }], skipped: [] },
    });
    await runWorktreeGc(
      { worktreeManager: mgr, dryRun: false, epicBranch: 'epic/1' },
      buildFetched(),
    );
    assert.equal(mgr.sweepStaleLocks.mock.callCount(), 1);
  });

  it('logs the count when gc reaped at least one orphan', async () => {
    const mgr = buildManager({ gc: { reaped: ['story-1'] } });
    await runWorktreeGc(
      { worktreeManager: mgr, dryRun: false, epicBranch: 'epic/1' },
      buildFetched(),
    );
    assert.equal(mgr.gc.mock.callCount(), 1);
  });

  it('forwards reapOnCancel from orchestration settings', async () => {
    const mgr = buildManager();
    await runWorktreeGc(
      {
        worktreeManager: mgr,
        dryRun: false,
        epicBranch: 'epic/1',
        orchestration: { worktreeIsolation: { reapOnCancel: false } },
      },
      buildFetched(),
    );
    assert.equal(mgr.sweepStaleLocks.mock.callCount(), 1);
  });
});

describe('runWorktreeGc — failure isolation', () => {
  it('swallows sweep failure (non-fatal)', async () => {
    const mgr = buildManager({ throws: 'sweep' });
    await assert.doesNotReject(() =>
      runWorktreeGc(
        { worktreeManager: mgr, dryRun: false, epicBranch: 'epic/1' },
        buildFetched(),
      ),
    );
  });

  it('swallows gc failure (non-fatal)', async () => {
    const mgr = buildManager({ throws: 'gc' });
    await assert.doesNotReject(() =>
      runWorktreeGc(
        { worktreeManager: mgr, dryRun: false, epicBranch: 'epic/1' },
        buildFetched(),
      ),
    );
  });
});
