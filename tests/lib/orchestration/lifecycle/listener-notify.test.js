// tests/lib/orchestration/lifecycle/listener-notify.test.js
/**
 * Unit test for NotifyDispatcher (Story #2239 Task #2244). Verifies:
 *
 *   - The set of webhook event names this listener can emit is a
 *     subset of `NOTIFICATIONS_DEFAULTS.webhookEvents`
 *     (`.agentrc.json` allowlist parity).
 *   - One `notify` call per `(event, seqId)`.
 *   - A `notification.emitted` trace row lands on disk via the
 *     injected `appendEpicSignal`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NOTIFICATIONS_DEFAULTS } from '../../../../.agents/scripts/lib/config/github.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  NotifyDispatcher,
  webhookEventNames,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/notify-dispatcher.js';

describe('NotifyDispatcher', () => {
  it('webhookEventNames() is a subset of notifications.webhookEvents defaults', () => {
    const allowlist = new Set(NOTIFICATIONS_DEFAULTS.webhookEvents);
    for (const name of webhookEventNames()) {
      assert.ok(
        allowlist.has(name),
        `webhook event "${name}" must appear in NOTIFICATIONS_DEFAULTS.webhookEvents`,
      );
    }
  });

  it('fires the notify function once per (event, seqId)', async () => {
    const bus = new Bus();
    const notifyCalls = [];
    const traceCalls = [];
    const dispatcher = new NotifyDispatcher({
      epicId: 1234,
      notify: async (ticketId, payload, opts) => {
        notifyCalls.push({ ticketId, payload, opts });
      },
      appendEpicSignal: async ({ signal }) => {
        traceCalls.push(signal);
        return true;
      },
      logger: { debug() {}, warn() {} },
    });
    dispatcher.register(bus);

    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 1: 'done' },
    });
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].ticketId, 1234);
    assert.equal(notifyCalls[0].payload.event, 'epic-progress');
    assert.equal(notifyCalls[0].opts.skipComment, true);

    // Replay with the same seqId — no second notify, no second trace.
    await dispatcher.handle({
      event: 'wave.end',
      seqId: 1,
      payload: { waveIndex: 0, outcomes: { 1: 'done' } },
    });
    assert.equal(notifyCalls.length, 1);
    assert.equal(traceCalls.length, 1);
  });

  it('maps epic.blocked / epic.unblocked / epic.complete to their webhook names', async () => {
    const bus = new Bus();
    const notifyCalls = [];
    const dispatcher = new NotifyDispatcher({
      epicId: 99,
      notify: async (ticketId, payload) => {
        notifyCalls.push(payload.event);
      },
      logger: { debug() {}, warn() {} },
    });
    dispatcher.register(bus);

    await bus.emit('epic.blocked', { reason: 'halt' });
    await bus.emit('epic.unblocked', { reason: 'resume' });
    await bus.emit('epic.complete', {
      epicId: 99,
      prUrl: 'https://example.com/pr/1',
    });

    assert.deepEqual(notifyCalls, [
      'epic-blocked',
      'epic-unblocked',
      'epic-complete',
    ]);
  });

  it('appends a notification.emitted trace row keyed by seqId', async () => {
    const bus = new Bus();
    const traceCalls = [];
    const dispatcher = new NotifyDispatcher({
      epicId: 1234,
      notify: async () => {},
      appendEpicSignal: async ({ signal }) => {
        traceCalls.push(signal);
        return true;
      },
      logger: { debug() {}, warn() {} },
    });
    dispatcher.register(bus);

    await bus.emit('wave.end', {
      waveIndex: 0,
      outcomes: { 1: 'done' },
    });
    assert.equal(traceCalls.length, 1);
    assert.equal(traceCalls[0].kind, 'notification.emitted');
    assert.equal(traceCalls[0].sourceEvent, 'wave.end');
    assert.equal(traceCalls[0].webhookEvent, 'epic-progress');
    assert.equal(traceCalls[0].seqId, 1);
  });

  it('swallows notify errors so a flaky webhook does not crash the bus', async () => {
    const bus = new Bus();
    const dispatcher = new NotifyDispatcher({
      epicId: 99,
      notify: async () => {
        throw new Error('webhook 500');
      },
      logger: { debug() {}, warn() {} },
    });
    dispatcher.register(bus);
    await bus.emit('epic.blocked', { reason: 'halt' });
    // No throw → success.
  });
});
