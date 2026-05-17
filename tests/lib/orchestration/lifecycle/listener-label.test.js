// tests/lib/orchestration/lifecycle/listener-label.test.js
/**
 * Unit test for LabelTransitioner — verifies the event → label
 * mapping (`resolveTransition`) and the (event, seqId) idempotency
 * guard (Story #2239 Task #2242, Acceptance Spec AC-10).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  LabelTransitioner,
  resolveTransition,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/label-transitioner.js';
import { STATE_LABELS } from '../../../../.agents/scripts/lib/orchestration/ticketing.js';

describe('resolveTransition', () => {
  it('maps story.merged → DONE on the storyId', () => {
    const out = resolveTransition(
      'story.merged',
      { storyId: 42, sha: 'abc1234' },
      7,
    );
    assert.deepEqual(out, { ticketId: 42, state: STATE_LABELS.DONE });
  });

  it('maps story.blocked → BLOCKED on the storyId', () => {
    const out = resolveTransition(
      'story.blocked',
      { storyId: 42, reason: 'rebase conflict' },
      7,
    );
    assert.deepEqual(out, { ticketId: 42, state: STATE_LABELS.BLOCKED });
  });

  it('maps epic.blocked → BLOCKED on the epicId', () => {
    const out = resolveTransition('epic.blocked', { reason: 'halt' }, 99);
    assert.deepEqual(out, { ticketId: 99, state: STATE_LABELS.BLOCKED });
  });

  it('maps epic.unblocked → EXECUTING on the epicId', () => {
    const out = resolveTransition('epic.unblocked', { reason: 'resumed' }, 99);
    assert.deepEqual(out, { ticketId: 99, state: STATE_LABELS.EXECUTING });
  });

  it('maps epic.complete → DONE on the epicId from payload', () => {
    const out = resolveTransition(
      'epic.complete',
      { epicId: 99, prUrl: 'https://example.com' },
      99,
    );
    assert.deepEqual(out, { ticketId: 99, state: STATE_LABELS.DONE });
  });

  it('fans out wave.end blocked/failed outcomes into BLOCKED transitions only', () => {
    const out = resolveTransition(
      'wave.end',
      {
        waveIndex: 0,
        outcomes: { 1: 'done', 2: 'failed', 3: 'blocked', 4: 'skipped' },
      },
      9,
    );
    assert.ok(out && 'fanout' in out);
    const targets = out.fanout.sort((a, b) => a.ticketId - b.ticketId);
    assert.deepEqual(targets, [
      { ticketId: 2, state: STATE_LABELS.BLOCKED },
      { ticketId: 3, state: STATE_LABELS.BLOCKED },
    ]);
  });

  it('returns null for wave.end when every outcome is done/skipped', () => {
    const out = resolveTransition(
      'wave.end',
      { waveIndex: 0, outcomes: { 1: 'done', 2: 'skipped' } },
      9,
    );
    assert.equal(out, null);
  });

  it('returns null for unknown events', () => {
    assert.equal(resolveTransition('not.a.real.event', {}, 1), null);
  });
});

describe('LabelTransitioner (bus integration)', () => {
  function buildListener({ calls }) {
    return new LabelTransitioner({
      provider: { tag: 'test-provider' },
      epicId: 100,
      transitionTicketState: async (provider, ticketId, state) => {
        calls.push({ provider, ticketId, state });
      },
      logger: { warn() {}, info() {}, debug() {} },
    });
  }

  it('writes one transition per (event, seqId) — second emit is a no-op', async () => {
    const bus = new Bus();
    const calls = [];
    const listener = buildListener({ calls });
    listener.register(bus);

    // First emit fires the transition.
    await bus.emit('story.merged', { storyId: 42, sha: 'abc1234' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ticketId, 42);
    assert.equal(calls[0].state, STATE_LABELS.DONE);

    // Manually re-invoke the handler with the same seqId — simulates
    // bus replay during resume. Must be a no-op.
    await listener.handle({
      event: 'story.merged',
      seqId: 1,
      payload: { storyId: 42, sha: 'abc1234' },
    });
    assert.equal(
      calls.length,
      1,
      'duplicate (event, seqId) must not flip the label twice',
    );
  });

  it('fans out wave.end to one transition per blocked/failed story', async () => {
    const bus = new Bus();
    const calls = [];
    const listener = buildListener({ calls });
    listener.register(bus);

    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 101: 'done', 102: 'failed', 103: 'blocked' },
    });
    const ids = calls.map((c) => c.ticketId).sort((a, b) => a - b);
    assert.deepEqual(ids, [102, 103]);
    for (const c of calls) {
      assert.equal(c.state, STATE_LABELS.BLOCKED);
    }
  });

  it('swallows transition errors so a flaky provider does not crash the bus', async () => {
    const bus = new Bus();
    const listener = new LabelTransitioner({
      provider: {},
      epicId: 100,
      transitionTicketState: async () => {
        throw new Error('GitHub 500');
      },
      logger: { warn() {}, info() {}, debug() {} },
    });
    listener.register(bus);

    // The bus must not propagate the listener error to its caller.
    await bus.emit('story.merged', { storyId: 42, sha: 'abc1234' });
    // No assertion needed beyond "no throw"; reaching this line is success.
  });
});
