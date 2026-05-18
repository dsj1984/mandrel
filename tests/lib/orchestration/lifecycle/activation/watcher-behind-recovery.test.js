// tests/lib/orchestration/lifecycle/activation/watcher-behind-recovery.test.js
/**
 * BEHIND auto-recovery preservation test
 * — Story #2327 / Task #2334.
 *
 * The legacy `pr-watch-with-update.js` CLI used to perform a
 * fast-forward recovery when every required check went green AND the
 * PR's `mergeStateStatus` was `BEHIND`: it issued one `gh pr
 * update-branch` call to merge the base into the head, then re-polled
 * the freshly-rebased commit's CI cycle. Story #2327 collapsed that
 * CLI to a thin `pr.created` emit shim; this test pins that the
 * Watcher listener still performs the same recovery flow when it
 * observes `pr.created`.
 *
 * Acceptance contract (Task #2334):
 *   - Stubbed gh CLI returns `mergeStateStatus: BEHIND` on the first
 *     view probe and `mergeStateStatus: CLEAN` on the second.
 *   - The stubbed `gh pr update-branch` invocation is recorded exactly
 *     once between the two view probes.
 *   - The Watcher emits `epic.watch.start` then `epic.watch.end`; the
 *     ledger (recording bus) shows the `epic.watch.end` emit after the
 *     recovery loop completes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { Watcher } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/watcher.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  bus.on('epic.watch.start', async (ctx) =>
    emits.push({ event: 'epic.watch.start', payload: ctx.payload }),
  );
  bus.on('epic.watch.end', async (ctx) =>
    emits.push({ event: 'epic.watch.end', payload: ctx.payload }),
  );
  return { bus, emits };
}

/**
 * Build a Watcher fixture wired against a deterministic stub gh CLI.
 * The fixture records every gh call in order so the test can assert
 * the canonical sequence: checks → view (BEHIND) → update-branch →
 * checks → view (CLEAN).
 */
function buildBehindRecoveryFixture() {
  const { bus, emits } = recordingBus();
  const calls = [];
  const checksResponse = {
    status: 0,
    stdout: JSON.stringify([
      { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
      { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
    ]),
    stderr: '',
  };
  const viewResponses = [
    { status: 0, stdout: JSON.stringify({ mergeStateStatus: 'BEHIND' }) },
    { status: 0, stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
  ];
  let viewIdx = 0;
  const watcher = new Watcher({
    bus,
    cwd: '/tmp',
    pollIntervalMs: 0,
    maxPolls: 10,
    maxUpdates: 3,
    sleepFn: async () => {},
    ghPrChecksFn: () => {
      calls.push({ cmd: 'gh pr checks' });
      return checksResponse;
    },
    ghPrViewFn: () => {
      calls.push({ cmd: 'gh pr view' });
      return viewResponses[Math.min(viewIdx++, viewResponses.length - 1)];
    },
    ghPrUpdateBranchFn: () => {
      calls.push({ cmd: 'gh pr update-branch' });
      return { status: 0, stdout: '', stderr: '' };
    },
    logger: quietLogger(),
  });
  watcher.register();
  return { bus, emits, calls, watcher };
}

describe('Watcher — mergeStateStatus BEHIND auto-recovery (Task #2334)', () => {
  it('issues exactly one gh pr update-branch between two view probes when first probe is BEHIND and second is CLEAN', async () => {
    const { bus, emits, calls } = buildBehindRecoveryFixture();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      head: 'epic/2306',
      base: 'main',
    });

    // The Watcher must emit start then end — the recovery loop runs
    // BETWEEN them, so epic.watch.end is the terminal observation.
    assert.deepEqual(
      emits.map((e) => e.event),
      ['epic.watch.start', 'epic.watch.end'],
      'Watcher must emit start → end across the recovery loop',
    );

    // Exactly one `gh pr update-branch` invocation, recorded between
    // the two `gh pr view` probes.
    const updateBranchCalls = calls.filter(
      (c) => c.cmd === 'gh pr update-branch',
    );
    assert.equal(
      updateBranchCalls.length,
      1,
      'BEHIND recovery must call gh pr update-branch exactly once',
    );
    const viewCalls = calls.filter((c) => c.cmd === 'gh pr view');
    assert.equal(
      viewCalls.length,
      2,
      'mergeStateStatus must be probed twice (BEHIND then CLEAN)',
    );

    // Ordering invariant: the update-branch call must land between
    // the two view probes. (Legacy parity: first view → BEHIND →
    // update-branch → second view → CLEAN.)
    const cmdOrder = calls.map((c) => c.cmd);
    const firstView = cmdOrder.indexOf('gh pr view');
    const lastView = cmdOrder.lastIndexOf('gh pr view');
    const update = cmdOrder.indexOf('gh pr update-branch');
    assert.ok(
      firstView < update && update < lastView,
      `update-branch must be between the two view probes; observed: ${cmdOrder.join(' → ')}`,
    );

    // The Watcher's classification log records the update count so the
    // ledger (and any downstream listener) can see that BEHIND recovery
    // fired — this is the same surface the legacy CLI exposed via its
    // stdout JSON envelope.
    const watcher = calls; // alias for readability below
    void watcher;
    const endEmit = emits.find((e) => e.event === 'epic.watch.end');
    assert.deepEqual(endEmit.payload.checkOutcomes, {
      'Validate and Test': 'success',
      baselines: 'success',
    });
  });

  it('records updatesApplied=1 on the watched classification for the BEHIND→CLEAN recovery path', async () => {
    const { bus, watcher } = buildBehindRecoveryFixture();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      head: 'epic/2306',
      base: 'main',
    });

    const watched = watcher.classifications.find(
      (c) => c.outcome === 'watched',
    );
    assert.ok(watched, 'expected a watched classification');
    assert.equal(
      watched.updatesApplied,
      1,
      'one update-branch call must be recorded on the classification',
    );
  });

  it('does NOT call update-branch when mergeStateStatus is already CLEAN on the first probe', async () => {
    const { bus, emits } = recordingBus();
    const calls = [];
    const watcher = new Watcher({
      bus,
      cwd: '/tmp',
      pollIntervalMs: 0,
      maxPolls: 5,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        calls.push({ cmd: 'gh pr checks' });
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
          ]),
          stderr: '',
        };
      },
      ghPrViewFn: () => {
        calls.push({ cmd: 'gh pr view' });
        return {
          status: 0,
          stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
          stderr: '',
        };
      },
      ghPrUpdateBranchFn: () => {
        calls.push({ cmd: 'gh pr update-branch' });
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    watcher.register();

    await bus.emit('pr.created', {
      prUrl: 'https://github.com/owner/repo/pull/1',
      head: 'epic/2306',
      base: 'main',
    });

    assert.equal(
      calls.filter((c) => c.cmd === 'gh pr update-branch').length,
      0,
      'update-branch must not fire when mergeStateStatus is CLEAN',
    );
    assert.deepEqual(
      emits.map((e) => e.event),
      ['epic.watch.start', 'epic.watch.end'],
    );
  });
});
