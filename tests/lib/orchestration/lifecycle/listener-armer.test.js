// tests/lib/orchestration/lifecycle/listener-armer.test.js
/**
 * Unit tests for the lifecycle AutomergeArmer listener
 * (Story #2256 / Task #2262).
 *
 * Acceptance contract:
 *   - Subscribes to `epic.merge.ready` (and ONLY that event).
 *   - Calls `gh pr view --json autoMergeRequest` first; if auto-merge
 *     is already armed, short-circuits to a single `epic.merge.armed`
 *     emit without re-issuing `gh pr merge`.
 *   - Otherwise calls `gh pr merge --auto --squash --delete-branch`
 *     then emits `epic.merge.armed`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  AutomergeArmer,
  parseAutoMergeArmed,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.merge.armed', record('epic.merge.armed'));
  return { bus, emits };
}

describe('parseAutoMergeArmed', () => {
  it('returns true when autoMergeRequest is a non-null object', () => {
    assert.equal(
      parseAutoMergeArmed(
        '{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"x"}}}',
      ),
      true,
    );
  });

  it('returns false when autoMergeRequest is null', () => {
    assert.equal(parseAutoMergeArmed('{"autoMergeRequest":null}'), false);
  });

  it('returns false for empty / malformed input', () => {
    assert.equal(parseAutoMergeArmed(''), false);
    assert.equal(parseAutoMergeArmed('not json'), false);
  });
});

describe('AutomergeArmer (bus integration)', () => {
  it('subscribes ONLY to epic.merge.ready', () => {
    const armer = new AutomergeArmer({
      bus: new Bus(),
      logger: quietLogger(),
    });
    assert.deepEqual(
      [...armer.events],
      ['epic.merge.ready'],
      'armer must subscribe to exactly one event',
    );
    assert.equal(
      armer.events.length,
      1,
      'armer.events.length must be 1 — merge-gate-ordering invariant depends on it',
    );
  });

  it('arms auto-merge and emits epic.merge.armed when not previously armed', async () => {
    const { bus, emits } = recordingBus();
    const mergeCalls = [];
    const armer = new AutomergeArmer({
      bus,
      // probe: not yet armed
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout: '{"autoMergeRequest":null}',
        stderr: '',
      }),
      ghPrMergeAutoFn: ({ prUrl }) => {
        mergeCalls.push(prUrl);
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    await bus.emit('epic.merge.ready', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      reason: 'all required checks green',
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.armed');
    assert.equal(mergeCalls.length, 1, 'gh pr merge --auto invoked once');
  });

  it('short-circuits to a single emit when auto-merge is already armed', async () => {
    const { bus, emits } = recordingBus();
    let mergeCalls = 0;
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout:
          '{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"bot"}}}',
        stderr: '',
      }),
      ghPrMergeAutoFn: () => {
        mergeCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    await bus.emit('epic.merge.ready', {
      prUrl: 'https://github.com/o/r/pull/9',
      reason: 'predicate clean',
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.armed');
    assert.equal(mergeCalls, 0, 'gh pr merge MUST NOT run when already armed');
    const existing = armer.classifications.find(
      (c) => c.outcome === 'existing',
    );
    assert.ok(existing, 'classification recorded as existing');
  });

  it('listener-level idempotency: repeat (event, seqId) emits nothing', async () => {
    const bus = new Bus();
    const armedEmits = [];
    bus.on('epic.merge.armed', async (ctx) =>
      armedEmits.push({ seqId: ctx.seqId }),
    );
    let mergeCalls = 0;
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout: '{"autoMergeRequest":null}',
        stderr: '',
      }),
      ghPrMergeAutoFn: () => {
        mergeCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    const ctx = {
      event: 'epic.merge.ready',
      seqId: 300,
      payload: {
        prUrl: 'https://github.com/o/r/pull/1',
        reason: 'clean',
      },
    };
    await armer.handle(ctx);
    await armer.handle(ctx);
    assert.equal(mergeCalls, 1, 'gh pr merge invoked exactly once');
    assert.equal(armedEmits.length, 1, 'epic.merge.armed emitted exactly once');
    const dup = armer.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup);
  });

  it('classifies failed and does not emit when arm call fails', async () => {
    const { bus, emits } = recordingBus();
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout: '{"autoMergeRequest":null}',
        stderr: '',
      }),
      ghPrMergeAutoFn: () => ({
        status: 2,
        stdout: '',
        stderr: 'gh: not authenticated',
      }),
      logger: quietLogger(),
    });
    armer.register();

    await bus.emit('epic.merge.ready', {
      prUrl: 'https://github.com/o/r/pull/9',
      reason: 'clean',
    });
    assert.equal(emits.length, 0, 'no epic.merge.armed on arm failure');
    const failed = armer.classifications.find((c) => c.outcome === 'failed');
    assert.ok(failed);
    assert.match(failed.reason, /arm-failed/);
  });

  it('proceeds with arm when the gh pr view probe itself fails', async () => {
    const { bus, emits } = recordingBus();
    const mergeCalls = [];
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 1,
        stdout: '',
        stderr: 'transient gh failure',
      }),
      ghPrMergeAutoFn: ({ prUrl }) => {
        mergeCalls.push(prUrl);
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();
    await bus.emit('epic.merge.ready', {
      prUrl: 'https://github.com/o/r/pull/9',
      reason: 'clean',
    });
    // probe failure must not block arming — the arm call is the
    // source of truth.
    assert.equal(mergeCalls.length, 1);
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.armed');
  });
});
