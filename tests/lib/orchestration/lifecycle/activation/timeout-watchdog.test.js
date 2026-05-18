// tests/lib/orchestration/lifecycle/activation/timeout-watchdog.test.js
/**
 * Activation-level unit test for the wired TimeoutWatchdog
 * (Story #2314, Task #2326).
 *
 * Acceptance contract:
 *   - When the registered observer's budget for a phase elapses BEFORE
 *     the matching `*.end` emit lands, exactly one `epic.blocked` event
 *     is emitted with reason `timeout:<phase>`.
 *   - The control run — same fixture, but the phase ends inside the
 *     budget — emits zero `epic.blocked` events.
 *
 * The watchdog itself is unit-tested in `listener-timeout.test.js`;
 * this test exercises the boot-time wiring (the
 * `registerReliabilityObservers` helper used by `factory.js`) so the
 * activation seam is covered as a single closed loop: budgets in →
 * lifecycle emission out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { registerReliabilityObservers } from '../../../../../.agents/scripts/lib/orchestration/epic-runner/factory.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a deterministic fake timer queue. The watchdog accepts
 * `setTimeoutFn` / `clearTimeoutFn` injection through its constructor;
 * because `registerReliabilityObservers` does not currently expose
 * those seams, this test installs the fakes on the returned instance
 * AFTER registration by replacing the bound functions and re-priming
 * the wildcard subscription on a fresh bus. Mirrors the fake used by
 * `listener-timeout.test.js`.
 */
function fakeTimerQueue() {
  let now = 0;
  const queue = [];
  let nextId = 1;
  function setTimeoutFn(fn, ms) {
    const id = nextId;
    nextId += 1;
    queue.push({ id, fireAt: now + ms, fn });
    return { id, unref() {} };
  }
  function clearTimeoutFn(handle) {
    if (!handle) return;
    const idx = queue.findIndex((q) => q.id === handle.id);
    if (idx >= 0) queue.splice(idx, 1);
  }
  function tick(ms) {
    const target = now + ms;
    while (queue.length > 0) {
      queue.sort((a, b) => a.fireAt - b.fireAt);
      if (queue[0].fireAt > target) break;
      const next = queue.shift();
      now = next.fireAt;
      next.fn();
    }
    now = target;
  }
  return { setTimeoutFn, clearTimeoutFn, tick };
}

/**
 * Record every `epic.blocked` emission on the bus so the assertions
 * can count exactly-once / never-emit semantics. The named listener
 * is registered AFTER the observer so it sees the watchdog's own
 * `bus.emit('epic.blocked', …)` on expiry.
 */
function recordEpicBlocked(bus) {
  const seen = [];
  bus.on('epic.blocked', async ({ payload, seqId }) => {
    seen.push({ seqId, payload });
  });
  return seen;
}

describe('TimeoutWatchdog activation — budget overrun → epic.blocked', () => {
  it('emits one epic.blocked when a synthesized phase exceeds its budget', async () => {
    const bus = new Bus();
    const blocked = recordEpicBlocked(bus);
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            // 1 second budget — short enough that the fake timer queue
            // can elapse it deterministically without sleeping.
            timeouts: { 'epic.finalize': 1 },
          },
        },
      },
      logger: quietLogger(),
    });
    // Swap in deterministic fake timers on the constructed instance.
    const timers = fakeTimerQueue();
    observers.timeoutWatchdog._setTimeoutFn = timers.setTimeoutFn;
    observers.timeoutWatchdog._clearTimeoutFn = timers.clearTimeoutFn;

    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Advance past the budget without ever firing the matching end.
    timers.tick(2000);
    // The watchdog kicks off `bus.emit('epic.blocked', …)` from the
    // timer callback without awaiting — drain the microtask queue so
    // the recorded emit lands before we assert.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(blocked.length, 1, 'expected exactly one epic.blocked emit');
    assert.equal(blocked[0].payload.reason, 'timeout:epic.finalize');
    const expired = observers.timeoutWatchdog.classifications.find(
      (c) => c.outcome === 'expired',
    );
    assert.ok(expired, 'watchdog should classify the timer as expired');
    assert.equal(expired.phase, 'epic.finalize');

    observers.timeoutWatchdog.dispose();
  });

  it('emits zero epic.blocked on the control run that finishes inside budget', async () => {
    const bus = new Bus();
    const blocked = recordEpicBlocked(bus);
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: { 'epic.finalize': 1 },
          },
        },
      },
      logger: quietLogger(),
    });
    const timers = fakeTimerQueue();
    observers.timeoutWatchdog._setTimeoutFn = timers.setTimeoutFn;
    observers.timeoutWatchdog._clearTimeoutFn = timers.clearTimeoutFn;

    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Within the 1s budget the matching `*.end` arrives; the watchdog
    // clears the armed timer.
    timers.tick(500);
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    // Push virtual time past where the budget would have expired —
    // the timer is gone so nothing fires.
    timers.tick(5000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      blocked.length,
      0,
      'no epic.blocked expected when the phase ends inside the budget',
    );
    const cleared = observers.timeoutWatchdog.classifications.find(
      (c) => c.outcome === 'cleared' && c.phase === 'epic.finalize',
    );
    assert.ok(cleared, 'watchdog should classify the timer as cleared');

    observers.timeoutWatchdog.dispose();
  });
});
