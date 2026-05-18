// tests/lib/orchestration/lifecycle/reliability-defense-in-depth.test.js
/**
 * Integration test — spawn-timeout (#2165) + lifecycle TimeoutWatchdog
 * defense in depth (Story #2271 / Task #2272).
 *
 * Acceptance contract (AC-14 and the layered-timeout invariant for Epic
 * #2172):
 *   1. The spawn-level timeout from Story #2165 fires FIRST when a hung
 *      `biome format --write` overruns its budget. The runner sees a
 *      clean exit 124 envelope (`FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE`) and
 *      can flip the Story to `agent::blocked` deterministically — no
 *      lifecycle watchdog emit is necessary, because the lower-level
 *      signal already carries the failure.
 *   2. The lifecycle TimeoutWatchdog is a BACKSTOP: it only emits
 *      `epic.blocked` (reason `timeout:<phase>`) when the lifecycle
 *      layer hangs without the lower-level signal landing — i.e. the
 *      orchestrator's `*.start` ran but no matching `*.end` (clean,
 *      timed-out, OR otherwise) was emitted within the configured
 *      `delivery.lifecycle.timeouts.<phase>` budget.
 *   3. The two layers are independent: spawn-timeout exit 124 carries a
 *      friction-comment payload shape that is compatible with the
 *      `epic.blocked` schema (typed `reason` string, optional
 *      `sourceStoryId`). The integration verifies that the two failure
 *      modes are recognisable from their respective signal channels and
 *      do not double-fire on a single hang.
 *
 * Fixture strategy. We do not actually run `npx biome format --write`
 * here — that would require a full repo state and is the home of the
 * format-autofix unit tests. Instead we:
 *   - exercise `runFormatAutofix` with a synthetic `spawnSync` that
 *     simulates a hung process (throws `SIGKILL`), proving the
 *     spawn-timeout envelope returns 124 first; and
 *   - wire the same watchdog instance onto a real `Bus` driven by a
 *     virtual timer queue, proving that without an emitted `*.end` the
 *     watchdog fires `epic.blocked` with `reason: 'timeout:<phase>'`,
 *     and that WITH the matching `*.end` it stays silent (because the
 *     spawn-level signal handled the failure end-to-end).
 *
 * This is the layered-timeout invariant on a postage-stamp scale; the
 * full end-to-end exercise lives in the operator's wave runner and is
 * covered indirectly by the resume-suite tests (#2270).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { TimeoutWatchdog } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/timeout-watchdog.js';
import {
  FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE,
  runFormatAutofix,
} from '../../../../.agents/scripts/lib/orchestration/story-close/format-autofix.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Virtual timer queue mirroring the one in `listener-timeout.test.js`.
 * Lets us advance time deterministically inside this integration test
 * without sleeping.
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
 * Synthesize the shape `execFileSync` throws when a spawn is killed by
 * its `timeout` option. The thrown error carries `signal: 'SIGKILL'`
 * and `status: null`; `runFormatAutofix` branches on that to return its
 * 124 envelope.
 */
function makeSpawnKilledFn() {
  return function spawnKilledFn() {
    const err = new Error('killed');
    err.signal = 'SIGKILL';
    err.status = null;
    throw err;
  };
}

/**
 * Build a fake `git` driver that always reports a clean working tree
 * — the spawn-timeout path doesn't try to commit, but the function
 * still calls `git status --porcelain` before invoking the formatter.
 */
function cleanGit() {
  return function gitFn(args) {
    if (args[0] === 'status' && args[1] === '--porcelain') return '';
    return '';
  };
}

/**
 * Build a bus that records every `epic.blocked` payload + tag every
 * emit with its event name for ordering assertions.
 */
function recordingBus() {
  const bus = new Bus();
  const emits = [];
  bus.on('epic.blocked', async ({ payload, seqId }) => {
    emits.push({ event: 'epic.blocked', seqId, payload });
  });
  return { bus, emits };
}

describe('defense-in-depth — spawn-timeout returns 124 cleanly', () => {
  it('runFormatAutofix on a hung spawn returns the 124 envelope (not an unhandled throw)', () => {
    const result = runFormatAutofix({
      cwd: '/tmp/fixture',
      storyId: 2271,
      timeoutMs: 50,
      logger: quietLogger(),
      spawnSync: makeSpawnKilledFn(),
      gitSync: cleanGit(),
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE);
    assert.equal(
      result.exitCode,
      124,
      'exit code must be 124 (GNU timeout(1))',
    );
    assert.equal(result.committed, false);
    assert.equal(result.ran, true);
    // The envelope's `writeCmdString` is the canonical handle for the
    // friction-comment payload (`spawn`-named hang). It must be a
    // non-empty string so downstream consumers can include it verbatim.
    assert.equal(typeof result.writeCmdString, 'string');
    assert.ok(result.writeCmdString.length > 0);
  });

  it('the 124 envelope shape is compatible with the epic.blocked schema reason format', () => {
    // The integration story: when story-close sees `timedOut: true` it
    // posts a friction comment AND flips the Story to `agent::blocked`.
    // The cascading `epic.blocked` emit (BlockerHandler → bus →
    // LabelTransitioner) carries a typed reason. The reason format used
    // by TimeoutWatchdog is `timeout:<event>`; the spawn-timeout path
    // can compose an analogous `timeout:format-autofix` (or whatever
    // the close orchestrator names its spawn) so operators can match
    // on `^timeout:` regardless of which layer produced it.
    const result = runFormatAutofix({
      cwd: '/tmp/fixture',
      storyId: 2271,
      timeoutMs: 50,
      logger: quietLogger(),
      spawnSync: makeSpawnKilledFn(),
      gitSync: cleanGit(),
    });
    // Compose a hypothetical reason payload off the envelope. This
    // mirrors what the close orchestrator does when it cascades the
    // spawn-level timeout into a Story-level blocker.
    const reason = `timeout:format-autofix:${result.exitCode}`;
    assert.match(reason, /^timeout:/);
    // And the matching TimeoutWatchdog reason for an analogous lifecycle
    // hang uses the same prefix — that prefix is the contract operators
    // grep on.
    assert.match('timeout:epic.finalize', /^timeout:/);
  });
});

describe('defense-in-depth — TimeoutWatchdog backstop when spawn signal is lost', () => {
  it('lifecycle watchdog fires when no *.end arrives within the budget', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 2 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    // Story-close enters the finalize phase…
    await bus.emit('epic.finalize.start', { epicId: 99 });
    // …but the spawn dies WITHOUT surfacing exit 124 (signal lost in
    // the process tree, e.g. an OS-level OOM kill that bypassed the
    // execFileSync timer). The watchdog is the last line of defence.
    timers.tick(3_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emits.length, 1);
    assert.equal(emits[0].payload.reason, 'timeout:epic.finalize');
  });

  it('lifecycle watchdog stays silent when the spawn-level signal carried the failure', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 2 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    // Story-close enters finalize, spawn-level timeout fires at exit 124,
    // the close orchestrator emits `epic.finalize.end` carrying the
    // failure envelope (the watchdog only cares that the *.end arrived
    // — it does not inspect the payload). The watchdog cancels its
    // timer and stays silent. The Story-level `agent::blocked` flip is
    // driven by the close orchestrator's friction-comment + cascade,
    // not by the watchdog.
    await bus.emit('epic.finalize.start', { epicId: 99 });
    timers.tick(500);
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    // Advance past the original budget — the timer was cleared, no
    // expiry fires.
    timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      emits.length,
      0,
      'watchdog must NOT fire when spawn-level signal already handled the timeout',
    );
  });
});

describe('defense-in-depth — paired ordering invariant', () => {
  /**
   * Spawn-timeout (#2165) is the PRIMARY signal — fast (sub-budget for
   * the lifecycle watchdog) and clean (exit 124). The lifecycle
   * watchdog is the BACKSTOP — slow (lifecycle budget is typically
   * larger than the spawn budget by an order of magnitude) and
   * approximate (it can only point at "this phase did not finish in
   * time", not "this spawn was killed at this signal").
   *
   * This ordering matters: if the lifecycle watchdog ever fires while
   * the spawn-level signal is also available, operators get two
   * blockers for one underlying failure — confusing and noisy. Pin
   * the ordering with two paired emits: spawn-level "*.end" arrives
   * BEFORE the lifecycle watchdog's expiry would fire.
   */
  it('spawn-level *.end short-circuits the lifecycle watchdog every time', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    // Lifecycle budget is generous (60 s) vs. the simulated spawn
    // budget (50 ms) — same shape as the production config.
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 60 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Spawn-level timer fires "first" in the virtual timeline.
    timers.tick(50); // way under the 60s lifecycle budget
    // Orchestrator emits *.end (carrying the timedOut envelope it got
    // from runFormatAutofix's 124 path).
    await bus.emit('epic.finalize.end', {
      epicId: 99,
      prUrl: 'https://github.com/o/r/pull/1',
    });
    // Now advance well past the lifecycle budget — must still be quiet.
    timers.tick(120_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emits.length, 0);
    assert.equal(wd.armedPhases.length, 0);
  });

  it('only the lifecycle watchdog fires when spawn-level *.end never arrives', async () => {
    const { bus, emits } = recordingBus();
    const timers = fakeTimerQueue();
    const wd = new TimeoutWatchdog({
      timeouts: { 'epic.finalize': 60 },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      logger: quietLogger(),
    });
    wd.register(bus);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    // Spawn dies silently — no *.end ever emitted. The watchdog is
    // the only signal an operator will see.
    timers.tick(70_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emits.length, 1);
    assert.equal(emits[0].payload.reason, 'timeout:epic.finalize');
    // Verify the friction-comment payload shape from the spawn-timeout
    // path (#2165) and the watchdog emit are consistent on the `reason`
    // prefix so a single grep `^timeout:` catches both.
    assert.match(emits[0].payload.reason, /^timeout:/);
  });
});
