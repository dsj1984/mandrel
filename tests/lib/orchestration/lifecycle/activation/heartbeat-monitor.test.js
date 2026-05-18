// tests/lib/orchestration/lifecycle/activation/heartbeat-monitor.test.js
/**
 * Activation-level unit test for the wired HeartbeatMonitor
 * (Story #2314, Task #2317).
 *
 * Acceptance contract:
 *   - With a synthesized idle gap longer than the configured threshold,
 *     the monitor surfaces exactly one warn-level log entry naming the
 *     idle gap duration.
 *   - The monitor never emits `epic.blocked` from the heartbeat path —
 *     the wildcard-firewall constraint requires observers to surface
 *     warnings via the injected logger only.
 *
 * The monitor itself is unit-tested in `listener-heartbeat.test.js`;
 * this test exercises the boot-time wiring (the
 * `registerReliabilityObservers` helper used by `factory.js`) so the
 * activation seam is covered end-to-end through the registration site.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { registerReliabilityObservers } from '../../../../../.agents/scripts/lib/orchestration/epic-runner/factory.js';

/**
 * Build a logger whose `warn` calls are captured for assertion. The
 * monitor only ever calls `logger.warn`, so the other levels are
 * silent stubs.
 */
function capturingLogger() {
  const warns = [];
  return {
    warns,
    warn: (msg) => warns.push(msg),
    info: () => {},
    debug: () => {},
  };
}

/**
 * Build a deterministic clock so the idle-gap fixture does not depend
 * on real wall-clock advancement. The monitor accepts `nowFn` via its
 * constructor; we install the fake on the registered instance through
 * the same internal slot the unit test uses.
 */
function virtualClock(startAtMs = 1_000_000) {
  let t = startAtMs;
  return {
    nowFn: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/**
 * Sentinel listener for `epic.blocked` — the heartbeat path must NEVER
 * cause this to fire. Any emission would indicate the monitor crossed
 * the wildcard-firewall.
 */
function recordEpicBlocked(bus) {
  const seen = [];
  bus.on('epic.blocked', async () => {
    seen.push(true);
  });
  return seen;
}

describe('HeartbeatMonitor activation — idle gap surfaces warn-level log', () => {
  it('warns exactly once for an idle gap longer than the threshold', async () => {
    const bus = new Bus();
    const logger = capturingLogger();
    const blocked = recordEpicBlocked(bus);
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: {},
            heartbeatWarnSeconds: 5,
          },
        },
      },
      logger,
    });
    const clock = virtualClock();
    observers.heartbeatMonitor._nowFn = clock.nowFn;

    // First emit primes the cursor without warning.
    await bus.emit('epic.finalize.start', { epicId: 99 });
    assert.equal(logger.warns.length, 0, 'priming emit must not warn');
    // Synthesize an idle gap longer than the 5s threshold.
    clock.advance(10_000);
    // Second emit triggers the warn.
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    assert.equal(
      logger.warns.length,
      1,
      'expected exactly one warn for the idle gap',
    );
    assert.match(
      logger.warns[0],
      /HeartbeatMonitor.*no lifecycle progress for 10s/,
      'warn must name the idle-gap duration',
    );
    // Sanity — the monitor's own warning ledger agrees.
    assert.equal(observers.heartbeatMonitor.warnings.length, 1);
    assert.equal(observers.heartbeatMonitor.warnings[0].gapMs, 10_000);
    // And the heartbeat path never emits `epic.blocked`.
    assert.equal(
      blocked.length,
      0,
      'HeartbeatMonitor must never emit epic.blocked',
    );
  });

  it('stays silent when gaps remain under the threshold', async () => {
    const bus = new Bus();
    const logger = capturingLogger();
    const blocked = recordEpicBlocked(bus);
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: {},
            heartbeatWarnSeconds: 60,
          },
        },
      },
      logger,
    });
    const clock = virtualClock();
    observers.heartbeatMonitor._nowFn = clock.nowFn;

    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Sub-threshold gap.
    clock.advance(30_000);
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    assert.equal(logger.warns.length, 0, 'no warn for sub-threshold gap');
    assert.equal(blocked.length, 0);
  });
});
