// tests/contract/lifecycle/merge-watcher-resume.test.js
/**
 * Contract test for the MergeWatcher listener
 * (Story #2896 / Task #2907, Epic #2880).
 *
 * Acceptance contract:
 *   - The module exports `{ events: ['epic.merge.armed'], handle }` shape
 *     (verified via the listener instance: `MergeWatcher.events` and
 *     `MergeWatcher.prototype.handle`).
 *   - When `gh pr view` returns a non-null `mergeCommit` on the FIRST
 *     poll, the listener emits exactly one `epic.merge.confirmed`
 *     event with payload `{ mergeCommitSha, mergedAt, pollAttempts: 1 }`
 *     (and the canonical `{ epicId, prNumber }` fields).
 *   - Resume semantics: simulating an interrupted poll where the
 *     ledger already contains attempts 1..3, the next run continues
 *     from attempt 4 (not 1), so the `pollAttempts` field on the
 *     emitted `epic.merge.confirmed` reflects the cumulative count.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  MergeWatcher,
  parseMergeView,
} from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/merge-watcher.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

describe('MergeWatcher — exported shape', () => {
  it('exposes events === ["epic.merge.armed"] and a handle() method', () => {
    const bus = new Bus();
    const w = new MergeWatcher({
      bus,
      epicId: 1,
      tempRoot: '/tmp',
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      ghPrViewMergeFn: () => ({ status: 0, stdout: '{}', stderr: '' }),
      sleepFn: async () => {},
      logger: quietLogger(),
    });
    assert.deepEqual([...w.events], ['epic.merge.armed']);
    assert.equal(typeof w.handle, 'function');
  });
});

describe('parseMergeView', () => {
  it('returns null sha when mergeCommit is null', () => {
    const r = parseMergeView(
      '{"mergeCommit":null,"mergedAt":null,"number":42}',
    );
    assert.equal(r.mergeCommitSha, null);
    assert.equal(r.mergedAt, null);
    assert.equal(r.prNumber, 42);
  });
  it('extracts mergeCommit.oid and mergedAt when present', () => {
    const r = parseMergeView(
      '{"mergeCommit":{"oid":"abc123"},"mergedAt":"2026-05-22T10:00:00Z","number":7}',
    );
    assert.equal(r.mergeCommitSha, 'abc123');
    assert.equal(r.mergedAt, '2026-05-22T10:00:00Z');
    assert.equal(r.prNumber, 7);
  });
});

describe('MergeWatcher — first-poll merge confirmation', () => {
  it('emits exactly one epic.merge.confirmed with pollAttempts: 1 when gh returns mergeCommit on first poll', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.merge.confirmed', async (ctx) => {
      emits.push({ seqId: ctx.seqId, payload: ctx.payload });
    });

    const appended = [];
    let ghCalls = 0;
    const watcher = new MergeWatcher({
      bus,
      epicId: 2880,
      tempRoot: '/t',
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: ({ record }) => appended.push(record),
      ghPrViewMergeFn: () => {
        ghCalls += 1;
        return {
          status: 0,
          stdout:
            '{"mergeCommit":{"oid":"deadbeef"},"mergedAt":"2026-05-22T11:22:33Z","number":4242}',
          stderr: '',
        };
      },
      sleepFn: async () => {},
      nowIsoFn: () => '2026-05-22T11:22:33Z',
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 100,
      payload: { prUrl: 'https://github.com/o/r/pull/4242' },
    });

    assert.equal(ghCalls, 1, 'gh pr view called exactly once');
    assert.equal(emits.length, 1, 'epic.merge.confirmed emitted exactly once');
    assert.deepEqual(emits[0].payload, {
      epicId: 2880,
      prUrl: 'https://github.com/o/r/pull/4242',
      prNumber: 4242,
      mergeCommitSha: 'deadbeef',
      mergedAt: '2026-05-22T11:22:33Z',
      pollAttempts: 1,
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].attempt, 1);
    assert.equal(appended[0].status, 'merged');
    assert.equal(
      watcher.classifications[0].outcome,
      'confirmed',
      'classification recorded as confirmed',
    );
  });
});

describe('MergeWatcher — resume continues from attempt N+1', () => {
  it('with prior attempts 1..3 in the ledger, the next confirmed emit carries pollAttempts: 4', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.merge.confirmed', async (ctx) => {
      emits.push(ctx.payload);
    });

    const appended = [];
    const watcher = new MergeWatcher({
      bus,
      epicId: 2880,
      tempRoot: '/t',
      // Simulate prior ledger state: attempts 1, 2, 3 already recorded.
      readPriorAttemptsFn: () => 3,
      appendAttemptFn: ({ record }) => appended.push(record),
      // This run's poll observes the merge on its first call —
      // which is attempt #4 in cumulative numbering.
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout:
          '{"mergeCommit":{"oid":"cafe1234"},"mergedAt":"2026-05-22T12:00:00Z","number":99}',
        stderr: '',
      }),
      sleepFn: async () => {},
      nowIsoFn: () => '2026-05-22T12:00:00Z',
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 200,
      payload: { prUrl: 'https://github.com/o/r/pull/99' },
    });

    assert.equal(emits.length, 1, 'one confirmed emit');
    assert.equal(
      emits[0].pollAttempts,
      4,
      'pollAttempts continues from 4, not 1',
    );
    assert.equal(emits[0].mergeCommitSha, 'cafe1234');
    assert.equal(appended.length, 1);
    assert.equal(
      appended[0].attempt,
      4,
      'ledger append records attempt=4 on the resumed poll',
    );
  });
});

describe('MergeWatcher — idempotency on duplicate (event, seqId)', () => {
  it('repeat invocation with the same seqId emits epic.merge.confirmed exactly once', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.merge.confirmed', async (ctx) => {
      emits.push(ctx.payload);
    });

    let ghCalls = 0;
    const watcher = new MergeWatcher({
      bus,
      epicId: 2880,
      tempRoot: '/t',
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      ghPrViewMergeFn: () => {
        ghCalls += 1;
        return {
          status: 0,
          stdout:
            '{"mergeCommit":{"oid":"sha"},"mergedAt":"2026-05-22T13:00:00Z","number":1}',
          stderr: '',
        };
      },
      sleepFn: async () => {},
      logger: quietLogger(),
    });
    watcher.register();

    const ctx = {
      event: 'epic.merge.armed',
      seqId: 500,
      payload: { prUrl: 'https://github.com/o/r/pull/1' },
    };
    await watcher.handle(ctx);
    await watcher.handle(ctx);
    await watcher.handle(ctx);

    assert.equal(ghCalls, 1, 'gh called exactly once across replays');
    assert.equal(emits.length, 1, 'confirmed emitted exactly once');
  });
});

describe('MergeWatcher — budget exhaustion', () => {
  it('returns failed/budget-exceeded without emitting confirmed when budget elapses', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.merge.confirmed', async (ctx) => emits.push(ctx.payload));

    // Fake clock that jumps by interval+1ms each call so the
    // second budget check trips immediately.
    let nowMs = 0;
    const watcher = new MergeWatcher({
      bus,
      epicId: 2880,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout: '{"mergeCommit":null,"mergedAt":null,"number":7}',
        stderr: '',
      }),
      sleepFn: async () => {},
      nowMsFn: () => {
        nowMs += 2000; // each call advances 2s; budget is 1s
        return nowMs;
      },
      nowIsoFn: () => '2026-05-22T14:00:00Z',
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 700,
      payload: { prUrl: 'https://github.com/o/r/pull/7' },
    });

    assert.equal(emits.length, 0, 'no confirmed emit on budget exhaustion');
    const last = watcher.classifications.at(-1);
    assert.equal(last.outcome, 'failed');
    assert.equal(last.reason, 'budget-exceeded');
  });
});
