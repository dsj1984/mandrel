// tests/lib/orchestration/lifecycle/listener-blocker.test.js
/**
 * Unit tests for the lifecycle BlockerHandler listener
 * (Story #2241 / Task #2246).
 *
 * Acceptance contract (Acceptance Spec AC-9 + AC-10):
 *   - Every `story.blocked` the listener observes is recorded in
 *     `classifications` — no silent skip (AC-9).
 *   - A repeat `(event, seqId)` short-circuits: `epic.blocked` is
 *     emitted at most once per unique seqId (AC-10).
 *   - `epic.blocked` carries `sourceStoryId` propagated from the
 *     incoming `story.blocked.storyId`, so an operator can trace the
 *     cascade.
 *   - `emitUnblocked()` is idempotent per recovery cycle.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  BlockerHandler,
  classifyStoryBlocked,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/blocker-handler.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a bus that records every `epic.blocked` and `epic.unblocked`
 * payload the listener emits. Used by tests that don't want the
 * privileged ledger writer in scope.
 */
function recordingBus() {
  const bus = new Bus();
  const emits = [];
  bus.on('epic.blocked', async ({ payload, seqId }) => {
    emits.push({ event: 'epic.blocked', seqId, payload });
  });
  bus.on('epic.unblocked', async ({ payload, seqId }) => {
    emits.push({ event: 'epic.unblocked', seqId, payload });
  });
  return { bus, emits };
}

describe('classifyStoryBlocked', () => {
  it('cascades a well-formed story.blocked payload', () => {
    const out = classifyStoryBlocked({ storyId: 42, reason: 'merge-conflict' });
    assert.deepEqual(out, {
      outcome: 'cascade',
      reason: 'merge-conflict',
      sourceStoryId: 42,
    });
  });

  it('marks malformed payload as failed (missing storyId)', () => {
    const out = classifyStoryBlocked({ reason: 'oops' });
    assert.equal(out.outcome, 'failed');
    assert.equal(out.reason, 'missing-storyId');
  });

  it('marks malformed payload as failed (missing reason)', () => {
    const out = classifyStoryBlocked({ storyId: 7 });
    assert.equal(out.outcome, 'failed');
    assert.equal(out.reason, 'missing-reason');
  });

  it('marks non-object payload as failed (invalid-payload)', () => {
    const out = classifyStoryBlocked(null);
    assert.equal(out.outcome, 'failed');
    assert.equal(out.reason, 'invalid-payload');
  });
});

describe('BlockerHandler (bus integration)', () => {
  it('cascades story.blocked to epic.blocked carrying sourceStoryId', async () => {
    const { bus, emits } = recordingBus();
    const handler = new BlockerHandler({
      bus,
      epicId: 100,
      logger: quietLogger(),
    });
    handler.register();

    await bus.emit('story.blocked', {
      storyId: 42,
      reason: 'timeout:biome-format',
    });

    const cascades = emits.filter((e) => e.event === 'epic.blocked');
    assert.equal(cascades.length, 1, 'one epic.blocked emit');
    assert.deepEqual(cascades[0].payload, {
      reason: 'timeout:biome-format',
      sourceStoryId: 42,
    });
  });

  it('records a classification entry for every story.blocked observed (AC-9)', async () => {
    const { bus } = recordingBus();
    const handler = new BlockerHandler({
      bus,
      epicId: 100,
      logger: quietLogger(),
    });
    handler.register();

    await bus.emit('story.blocked', { storyId: 1, reason: 'a' });
    await bus.emit('story.blocked', { storyId: 2, reason: 'b' });
    await bus.emit('story.blocked', { storyId: 3, reason: 'c' });

    assert.equal(
      handler.classifications.length,
      3,
      'three classification entries (no silent skip)',
    );
    for (const c of handler.classifications) {
      assert.equal(c.event, 'story.blocked');
      assert.equal(c.outcome, 'cascade');
    }
  });

  it('emits epic.blocked exactly once per unique (event, seqId) — AC-10 idempotency', async () => {
    const { bus, emits } = recordingBus();
    const handler = new BlockerHandler({
      bus,
      epicId: 100,
      logger: quietLogger(),
    });
    handler.register();

    // First emit cascades normally.
    await bus.emit('story.blocked', { storyId: 42, reason: 'r1' });
    assert.equal(emits.filter((e) => e.event === 'epic.blocked').length, 1);

    // Re-invoke handler with the SAME (event, seqId) — simulates a bus
    // replay during resume. Must NOT cascade a second time.
    await handler.handle({
      event: 'story.blocked',
      seqId: 1,
      payload: { storyId: 42, reason: 'r1' },
    });
    assert.equal(
      emits.filter((e) => e.event === 'epic.blocked').length,
      1,
      'duplicate (event, seqId) must not cascade twice',
    );

    // A fresh seqId from a real new emit DOES cascade.
    await bus.emit('story.blocked', { storyId: 43, reason: 'r2' });
    assert.equal(emits.filter((e) => e.event === 'epic.blocked').length, 2);

    // The duplicate entry was recorded explicitly with outcome=skipped.
    const skipped = handler.classifications.filter(
      (c) => c.outcome === 'skipped',
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, 'duplicate-seqId');
  });

  it('emitUnblocked emits epic.unblocked with the active cascade reason + sourceStoryId', async () => {
    const { bus, emits } = recordingBus();
    const handler = new BlockerHandler({
      bus,
      epicId: 100,
      logger: quietLogger(),
    });
    handler.register();

    await bus.emit('story.blocked', { storyId: 42, reason: 'r1' });
    const out = await handler.emitUnblocked();
    assert.equal(out.emitted, true);

    const unblocks = emits.filter((e) => e.event === 'epic.unblocked');
    assert.equal(unblocks.length, 1);
    assert.deepEqual(unblocks[0].payload, {
      reason: 'r1',
      sourceStoryId: 42,
    });
  });

  it('emitUnblocked is a no-op when no active cascade is tracked', async () => {
    const { bus, emits } = recordingBus();
    const handler = new BlockerHandler({
      bus,
      epicId: 100,
      logger: quietLogger(),
    });
    handler.register();

    const out = await handler.emitUnblocked();
    assert.equal(out.emitted, false);
    assert.equal(out.reason, 'no-active-cascade');
    assert.equal(
      emits.filter((e) => e.event === 'epic.unblocked').length,
      0,
      'no epic.unblocked emitted without an active cascade',
    );
  });

  it('emitUnblocked clears the active cascade so a second call is a no-op (idempotency per cycle)', async () => {
    const { bus, emits } = recordingBus();
    const handler = new BlockerHandler({
      bus,
      epicId: 100,
      logger: quietLogger(),
    });
    handler.register();

    await bus.emit('story.blocked', { storyId: 42, reason: 'r1' });
    const first = await handler.emitUnblocked();
    assert.equal(first.emitted, true);
    const second = await handler.emitUnblocked();
    assert.equal(second.emitted, false);
    assert.equal(second.reason, 'no-active-cascade');
    assert.equal(
      emits.filter((e) => e.event === 'epic.unblocked').length,
      1,
      'epic.unblocked emitted exactly once per recovery cycle',
    );
  });

  it('rejects a non-bus constructor argument with a clear TypeError', () => {
    assert.throws(
      () => new BlockerHandler({ epicId: 1 }),
      /BlockerHandler requires a bus/,
    );
  });

  it('rejects a non-positive epicId with a clear TypeError', () => {
    const { bus } = recordingBus();
    assert.throws(
      () => new BlockerHandler({ bus, epicId: 0 }),
      /BlockerHandler requires a numeric epicId/,
    );
  });
});
