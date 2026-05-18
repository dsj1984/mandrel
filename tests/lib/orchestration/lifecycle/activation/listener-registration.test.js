// tests/lib/orchestration/lifecycle/activation/listener-registration.test.js
/**
 * Boot-time listener census for the reliability observers wired by
 * `registerReliabilityObservers` (Story #2314, Tasks #2324 + #2323).
 *
 * Acceptance contract:
 *   - After `registerReliabilityObservers({ bus, config, logger })` runs,
 *     the bus reports a `TimeoutWatchdog` instance as a wildcard
 *     subscriber. Story #2323 will extend the census to assert
 *     `HeartbeatMonitor` is also registered.
 *   - Per-event budgets are sourced from
 *     `config.delivery.lifecycle.timeouts`; the watchdog arms a timer
 *     for any phase whose `*.start` event lands and whose name appears
 *     in the budget map.
 *   - The registration helper is a no-op when `bus` is missing or does
 *     not expose `on()` / `emit()` — protects unit fixtures with a
 *     minimal collaborators bag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { registerReliabilityObservers } from '../../../../../.agents/scripts/lib/orchestration/epic-runner/factory.js';
import { TimeoutWatchdog } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/timeout-watchdog.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Read the wildcard listener array out of the bus via its private slot.
 * The Bus class stores wildcard subscribers on `_wildcards` (see
 * `lib/orchestration/lifecycle/bus.js`). The boot-time census needs
 * direct visibility because there is no `bus.listeners('*')` public API.
 */
function wildcardCount(bus) {
  return bus._wildcards.length;
}

describe('registerReliabilityObservers — boot-time listener census', () => {
  it('registers TimeoutWatchdog as a wildcard subscriber', () => {
    const bus = new Bus();
    const before = wildcardCount(bus);
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: { 'acceptance.reconcile': 600, 'epic.finalize': 600 },
          },
        },
      },
      logger: quietLogger(),
    });
    assert.ok(observers, 'expected observers bag to be returned');
    assert.ok(
      observers.timeoutWatchdog instanceof TimeoutWatchdog,
      'expected a TimeoutWatchdog instance',
    );
    assert.equal(
      wildcardCount(bus) - before,
      1,
      'TimeoutWatchdog should add exactly one wildcard subscriber',
    );
  });

  it('threads delivery.lifecycle.timeouts into the watchdog', async () => {
    const bus = new Bus();
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: { 'acceptance.reconcile': 1 },
          },
        },
      },
      logger: quietLogger(),
    });
    // Emitting `acceptance.reconcile.start` should arm the watchdog
    // because the budget is configured; absence of `epic.finalize` in
    // the map means a finalize start is silently skipped.
    await bus.emit('acceptance.reconcile.start', { epicId: 99 });
    assert.deepEqual(observers.timeoutWatchdog.armedPhases, [
      'acceptance.reconcile',
    ]);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    assert.deepEqual(
      observers.timeoutWatchdog.armedPhases,
      ['acceptance.reconcile'],
      'epic.finalize must not arm without a configured budget',
    );
    observers.timeoutWatchdog.dispose();
  });

  it('tolerates a missing delivery.lifecycle block', () => {
    const bus = new Bus();
    const observers = registerReliabilityObservers({
      bus,
      config: {}, // no delivery.lifecycle
      logger: quietLogger(),
    });
    assert.ok(observers, 'should still register when config is bare');
    assert.ok(observers.timeoutWatchdog instanceof TimeoutWatchdog);
    assert.equal(wildcardCount(bus), 1);
  });

  it('returns null for an unbusable bus argument', () => {
    assert.equal(registerReliabilityObservers({ bus: null }), null);
    assert.equal(registerReliabilityObservers({ bus: {} }), null);
    assert.equal(
      registerReliabilityObservers({ bus: { on: () => {} } }),
      null,
      'a bus missing emit() must be rejected',
    );
  });
});
