// tests/lib/orchestration/lifecycle/listener-timeout.test.js
/**
 * Unit tests for the lifecycle TimeoutWatchdog listener
 * (Story #2271 / Task #2273).
 *
 * Acceptance contract:
 *   - Wildcard observer (`bus.on('*', fn)`) arms a per-phase timer at
 *     `<phase>.start` keyed by the configured `delivery.lifecycle.timeouts`
 *     map (eventName → seconds).
 *   - The matching `<phase>.end` cancels the timer; no `epic.blocked` is
 *     emitted on a healthy phase.
 *   - Expiry of an armed timer emits `epic.blocked` with the typed reason
 *     `timeout:<phase>` exactly once.
 *   - Events without a configured budget are silently skipped (no timer).
 *   - Re-arming the same phase replaces the existing timer (resume
 *     contract — last `*.start` wins).
 *   - Wildcard-observer firewall compliance: this module is the ONE
 *     wildcard observer that emits, and it imports NO state-mutating
 *     modules (verified by the corresponding lint test below).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findWildcardObserverFirewallViolations } from '../../../../.agents/scripts/check-lifecycle-lint.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  createTimeoutWatchdog,
  parsePhaseEvent,
  TimeoutWatchdog,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/timeout-watchdog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a fake timer queue. Calling `tick(ms)` advances virtual time and
 * fires any expired callbacks in FIFO order. The watchdog accepts these
 * via `setTimeoutFn` / `clearTimeoutFn` injection so the unit tests
 * neither sleep nor depend on real wall-clock timers.
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
  function pending() {
    return queue.length;
  }
  return { setTimeoutFn, clearTimeoutFn, tick, pending };
}

/**
 * Build a bus that records every `epic.blocked` payload, plus the
 * timing-relevant phase events the watchdog observes.
 */
function recordingBus() {
  const bus = new Bus();
  const emits = [];
  bus.on('epic.blocked', async ({ payload, seqId }) => {
    emits.push({ event: 'epic.blocked', seqId, payload });
  });
  return { bus, emits };
}

describe('parsePhaseEvent', () => {
  it('extracts phase + boundary for *.start / *.end events', () => {
    assert.deepEqual(parsePhaseEvent('acceptance.reconcile.start'), {
      phase: 'acceptance.reconcile',
      boundary: 'start',
    });
    assert.deepEqual(parsePhaseEvent('epic.finalize.end'), {
      phase: 'epic.finalize',
      boundary: 'end',
    });
    assert.deepEqual(parsePhaseEvent('wave.start'), {
      phase: 'wave',
      boundary: 'start',
    });
  });

  it('returns null for non-paired events', () => {
    assert.equal(parsePhaseEvent('epic.blocked'), null);
    assert.equal(parsePhaseEvent('story.merged'), null);
    assert.equal(parsePhaseEvent('pr.created'), null);
    assert.equal(parsePhaseEvent(''), null);
    assert.equal(parsePhaseEvent(undefined), null);
  });
});

describe('TimeoutWatchdog — arming and clearing', () => {
  it('arms a timer on *.start when a budget is configured', async () => {
    const { bus } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'acceptance.reconcile': 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('acceptance.reconcile.start', { epicId: 99 });
    assert.deepEqual(wd.armedPhases, ['acceptance.reconcile']);
    assert.equal(timers.pending(), 1);
    const armed = wd.classifications.find((c) => c.outcome === 'armed');
    assert.ok(armed, 'expected an armed classification');
    assert.equal(armed.phase, 'acceptance.reconcile');
  });

  it('clears the timer on the matching *.end without emitting epic.blocked', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    assert.equal(wd.armedPhases.length, 0);
    assert.equal(timers.pending(), 0);
    assert.equal(emits.length, 0, 'no epic.blocked expected on clean end');
    const cleared = wd.classifications.find((c) => c.outcome === 'cleared');
    assert.ok(cleared, 'expected a cleared classification');
  });

  it('skips events with no configured budget (silent opt-out)', async () => {
    const { bus } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: {}, // no budgets
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    assert.equal(timers.pending(), 0);
    assert.equal(wd.armedPhases.length, 0);
    const skipped = wd.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'no-budget-configured',
    );
    assert.ok(skipped, 'expected a skipped classification');
  });

  it('replaces the prior timer when *.start fires twice (re-arming)', async () => {
    const { bus } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 5 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Only one timer should remain — the replacement.
    assert.equal(timers.pending(), 1);
    const replaced = wd.classifications.find((c) => c.outcome === 'replaced');
    assert.ok(replaced, 'expected a replaced classification on re-arm');
  });

  it('ignores *.end with no armed timer', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    // Emit end without start — payload-required but the watchdog
    // doesn't care, the schema validation does (use a known schema).
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    assert.equal(emits.length, 0);
    const skipped = wd.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'no-armed-timer',
    );
    assert.ok(skipped, 'expected a no-armed-timer skipped classification');
  });
});

describe('TimeoutWatchdog — expiry semantics', () => {
  it('emits epic.blocked with reason timeout:<phase> on expiry', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'acceptance.reconcile': 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('acceptance.reconcile.start', { epicId: 99 });
    // Advance past the budget — the timer fires synchronously inside
    // `tick`, which kicks off the async `bus.emit('epic.blocked', …)`.
    timers.tick(2000);
    // Wait for the microtask queue to drain so the recorded emit lands.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emits.length, 1, 'expected exactly one epic.blocked emit');
    assert.equal(emits[0].event, 'epic.blocked');
    assert.equal(emits[0].payload.reason, 'timeout:acceptance.reconcile');
    const expired = wd.classifications.find((c) => c.outcome === 'expired');
    assert.ok(expired, 'expected an expired classification');
    assert.equal(expired.reason, 'timeout:acceptance.reconcile');
    // The timer record is cleared after expiry — a late-arriving end is
    // a no-armed-timer skip.
    assert.equal(wd.armedPhases.length, 0);
  });

  it('does not double-emit when *.end arrives after expiry', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 1 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emits.length, 1);
    // Late end — should be ignored as no-armed-timer.
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    assert.equal(emits.length, 1, 'no second emit on late end');
    const lateSkip = wd.classifications.find(
      (c) =>
        c.outcome === 'skipped' &&
        c.reason === 'no-armed-timer' &&
        c.phase === 'epic.finalize',
    );
    assert.ok(lateSkip, 'expected late end to be classified as no-armed-timer');
  });

  it('dispose() clears any armed timers', async () => {
    const { bus } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 5, 'acceptance.reconcile': 5 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    await bus.emit('acceptance.reconcile.start', { epicId: 99 });
    assert.equal(timers.pending(), 2);
    wd.dispose();
    assert.equal(timers.pending(), 0);
    assert.equal(wd.armedPhases.length, 0);
  });
});

describe('TimeoutWatchdog — paired-timer ordering (spawn vs lifecycle)', () => {
  /**
   * Sanity assertion that proves the watchdog is a backstop, not the
   * primary signal: a spawn-level timeout (Story #2165) fires FIRST
   * with a clean exit 124 path, and the lifecycle watchdog only fires
   * when the lifecycle layer hangs without that lower-level signal
   * landing. The full integration test lives in
   * `reliability-defense-in-depth.test.js` (Task #2272) — this
   * micro-fixture just pins the ordering primitive.
   */
  it('lifecycle expiry fires only when no *.end arrives within budget', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 2 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Spawn-level timeout (simulated) lands first and the orchestrator
    // emits `epic.finalize.end` cleanly — the watchdog clears.
    timers.tick(500);
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    assert.equal(
      emits.length,
      0,
      'watchdog must NOT fire when spawn handled it',
    );
    // Second phase: spawn dies silently, no *.end ever arrives, watchdog
    // fires as the backstop.
    await bus.emit('epic.finalize.start', { epicId: 99 });
    timers.tick(3000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      emits.length,
      1,
      'watchdog must fire when spawn signal is lost',
    );
    assert.equal(emits[0].payload.reason, 'timeout:epic.finalize');
  });
});

describe('TimeoutWatchdog — factory + registration guards', () => {
  it('createTimeoutWatchdog returns an instance', () => {
    const wd = createTimeoutWatchdog({});
    assert.ok(wd instanceof TimeoutWatchdog);
  });

  it('register() throws when bus is missing required methods', () => {
    const wd = new TimeoutWatchdog({});
    assert.throws(() => wd.register(null), /bus must expose/);
    assert.throws(() => wd.register({}), /bus must expose/);
    assert.throws(() => wd.register({ on: () => {} }), /bus must expose/);
  });
});

describe('TimeoutWatchdog — wildcard-observer firewall compliance', () => {
  /**
   * The lifecycle lint rule (`check-lifecycle-lint.js` Rule 2) forbids
   * a wildcard observer from importing any state-mutating module.
   * TimeoutWatchdog is the ONE wildcard observer that emits on the bus;
   * it satisfies the firewall by importing nothing else. This test
   * pins the contract so a future refactor that adds (say) a
   * `notify.js` import to the watchdog breaks the build.
   */
  it('static lint sweep over the watchdog file is clean', () => {
    const listenerDir = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'lifecycle',
      'listeners',
    );
    // Sanity — the listener file is actually present.
    const watchdogPath = path.join(listenerDir, 'timeout-watchdog.js');
    const src = readFileSync(watchdogPath, 'utf8');
    assert.ok(src.includes("bus.on('*'"), 'expected wildcard registration');
    // Run the lint rule. The directory walk picks up every wildcard
    // observer (heartbeat-monitor.js, trace-logger uses a different
    // surface). Filter to our file for a focused assertion.
    const violations = findWildcardObserverFirewallViolations(listenerDir);
    const ours = violations.filter((v) => v.file === watchdogPath);
    assert.deepEqual(
      ours,
      [],
      `timeout-watchdog.js must not import state-mutating modules: ${JSON.stringify(ours)}`,
    );
  });
});
