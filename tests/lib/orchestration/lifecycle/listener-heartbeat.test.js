// tests/lib/orchestration/lifecycle/listener-heartbeat.test.js
/**
 * Unit tests for the lifecycle HeartbeatMonitor listener
 * (Story #2271 / Task #2275).
 *
 * Acceptance contract:
 *   - Wildcard observer registered as `bus.on('*', fn)`; tracks
 *     wall-clock per emit.
 *   - Surfaces exactly one `logger.warn` per quiet gap that crosses
 *     `delivery.lifecycle.heartbeatWarnSeconds` (default 60).
 *   - Sub-threshold gaps are silent.
 *   - `check()` allows the runner to surface a warning without waiting
 *     for the next emit (used before long-running sub-process spawns).
 *   - Wildcard-observer firewall compliance: HeartbeatMonitor imports
 *     no state-mutating modules and never calls `bus.emit()`. Verified
 *     by the lint sweep + a static source-read assertion.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  findWildcardObserverFirewallViolations,
  stripComments,
} from '../../../../.agents/scripts/check-lifecycle-lint.js';
import {
  createHeartbeatMonitor,
  DEFAULT_HEARTBEAT_WARN_SECONDS,
  HeartbeatMonitor,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/heartbeat-monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a logger that captures every `warn()` call into an array so
 * tests can assert exactly-once behavior without spy frameworks.
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
 * Build a virtual clock so tests can advance time deterministically.
 * Returns `{ nowFn, advance(ms) }` — `nowFn` matches `Date.now`'s
 * millisecond contract.
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

describe('HeartbeatMonitor — construction', () => {
  it('uses the default warnSeconds when none is provided', () => {
    const hm = new HeartbeatMonitor({});
    assert.equal(hm.warnSeconds, DEFAULT_HEARTBEAT_WARN_SECONDS);
    assert.equal(hm.warnMs, DEFAULT_HEARTBEAT_WARN_SECONDS * 1000);
  });

  it('honours an explicit warnSeconds value', () => {
    const hm = new HeartbeatMonitor({ warnSeconds: 30 });
    assert.equal(hm.warnSeconds, 30);
    assert.equal(hm.warnMs, 30_000);
  });

  it('rejects non-positive warnSeconds', () => {
    assert.throws(() => new HeartbeatMonitor({ warnSeconds: 0 }), RangeError);
    assert.throws(() => new HeartbeatMonitor({ warnSeconds: -1 }), RangeError);
  });

  it('createHeartbeatMonitor returns an instance', () => {
    const hm = createHeartbeatMonitor({});
    assert.ok(hm instanceof HeartbeatMonitor);
  });
});

describe('HeartbeatMonitor — observation cadence', () => {
  it('stays silent when emits arrive within the threshold', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    clock.advance(30_000); // 30s — below threshold
    await bus.emit('epic.snapshot.end', { epicId: 99, storyIds: [] });
    assert.equal(log.warns.length, 0);
    assert.equal(hm.warnings.length, 0);
  });

  it('warns exactly once when a gap crosses the threshold', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    clock.advance(90_000); // 90s gap
    await bus.emit('epic.snapshot.end', { epicId: 99, storyIds: [] });
    assert.equal(log.warns.length, 1, 'expected exactly one warn');
    assert.equal(hm.warnings.length, 1);
    const w = hm.warnings[0];
    assert.equal(w.event, 'epic.snapshot.end');
    assert.equal(w.previousEvent, 'epic.snapshot.start');
    assert.ok(w.gapMs >= 60_000);
    assert.ok(
      log.warns[0].includes('no lifecycle progress'),
      `expected warn message to include 'no lifecycle progress', got: ${log.warns[0]}`,
    );
  });

  it('surfaces a warning for each independent quiet gap', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    // gap 1: 90s
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    clock.advance(90_000);
    await bus.emit('epic.snapshot.end', { epicId: 99, storyIds: [] });
    // gap 2: 30s (below threshold) — no extra warn
    clock.advance(30_000);
    await bus.emit('epic.plan.start', { epicId: 99 });
    // gap 3: 120s — second warn
    clock.advance(120_000);
    await bus.emit('epic.plan.end', { waves: [[1]] });
    assert.equal(log.warns.length, 2, 'expected exactly two warns');
  });

  it('does not warn on the first emit (no prior reference)', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    assert.equal(log.warns.length, 0);
  });
});

describe('HeartbeatMonitor — runner-driven check()', () => {
  it('returns null when no prior emit has landed', () => {
    const hm = new HeartbeatMonitor({});
    assert.equal(hm.check(), null);
  });

  it('returns null when the current gap is below threshold', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    clock.advance(10_000);
    assert.equal(hm.check(), null);
    assert.equal(log.warns.length, 0);
  });

  it('surfaces a warning when the gap crosses threshold without a new emit', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    clock.advance(75_000);
    const rec = hm.check();
    assert.ok(rec, 'expected a warning record');
    assert.equal(rec.event, '(check)');
    assert.equal(log.warns.length, 1);
    // Calling check() again at the SAME wall-clock is idempotent.
    const second = hm.check();
    assert.equal(second, null);
    assert.equal(log.warns.length, 1);
  });
});

describe('HeartbeatMonitor — reset + introspection', () => {
  it('reset() clears the cursor and warnings log', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    clock.advance(90_000);
    await bus.emit('epic.snapshot.end', { epicId: 99, storyIds: [] });
    assert.equal(hm.warnings.length, 1);
    hm.reset();
    assert.equal(hm.warnings.length, 0);
    assert.equal(hm.lastEmit, null);
  });

  it('lastEmit reflects the most recent emit', async () => {
    const clock = virtualClock();
    const log = capturingLogger();
    const hm = new HeartbeatMonitor({
      warnSeconds: 60,
      logger: log,
      nowFn: clock.nowFn,
    });
    const bus = new Bus();
    hm.register(bus);
    await bus.emit('epic.snapshot.start', { epicId: 99 });
    const snap = hm.lastEmit;
    assert.ok(snap);
    assert.equal(snap.event, 'epic.snapshot.start');
  });
});

describe('HeartbeatMonitor — registration guard', () => {
  it('register() throws when bus is missing .on()', () => {
    const hm = new HeartbeatMonitor({});
    assert.throws(() => hm.register(null), /bus must expose/);
    assert.throws(() => hm.register({}), /bus must expose/);
  });
});

describe('HeartbeatMonitor — wildcard-observer firewall compliance', () => {
  /**
   * Static contract: the listener is the canonical "observation only"
   * wildcard observer and must not import any state-mutating module,
   * must not call bus.emit, and must not reach into the GitHub or git
   * surfaces.
   */
  it('static lint sweep over the monitor file is clean', () => {
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
    const monitorPath = path.join(listenerDir, 'heartbeat-monitor.js');
    const src = readFileSync(monitorPath, 'utf8');
    assert.ok(src.includes("bus.on('*'"), 'expected wildcard registration');
    const violations = findWildcardObserverFirewallViolations(listenerDir);
    const ours = violations.filter((v) => v.file === monitorPath);
    assert.deepEqual(
      ours,
      [],
      `heartbeat-monitor.js must not import state-mutating modules: ${JSON.stringify(ours)}`,
    );
  });

  it('the monitor source contains no bus.emit call', () => {
    const monitorPath = path.resolve(
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
      'heartbeat-monitor.js',
    );
    // Defensive — protects against a future refactor accidentally
    // turning the observer into an emitter, which would violate the
    // wildcard firewall in a way the static lint rule does NOT yet
    // model (the lint rule blocks state-mutating imports, not bus
    // emission). This in-test guard is the explicit "observer-only"
    // pin Tech Spec § Bus contract requires for heartbeat observers.
    // Comments are stripped before scanning so the docstring's
    // prohibition reference (`bus.emit()`) does not trip the check.
    const src = stripComments(readFileSync(monitorPath, 'utf8'));
    const emitMatch = src.match(/\bbus\s*\.\s*emit\s*\(/);
    assert.equal(
      emitMatch,
      null,
      'HeartbeatMonitor must not call bus.emit — it is observe-only',
    );
  });
});
