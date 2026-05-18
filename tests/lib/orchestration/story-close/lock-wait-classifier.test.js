/**
 * tests/lib/orchestration/story-close/lock-wait-classifier.test.js
 *
 * Three fixtures that lock in the windowed CPU + freshness behaviour of
 * `classifyLockHolder` (Story #2509, Epic #2501 — retro follow-up from
 * Epic #2453's lock-holder false-positive in Story #2462):
 *
 *   1. **live-and-working** — process is 30 minutes old and accumulates
 *      5 CPU-seconds across the sampling window → verdict `'live'`
 *      with reason `cpu-progress-observed`.
 *   2. **genuinely-stalled** — process is 30 minutes old and shows 0 CPU
 *      progress across two windows → verdict `'stale'` with reason
 *      `no-cpu-progress`.
 *   3. **just-started** — process is 2 minutes old with 0 CPU; the
 *      freshness gate wins → verdict `'live'` with reason
 *      `freshness-gate`, and the CPU probe is NOT consulted.
 *
 * All probes are injected so the test runs deterministically with no
 * real spawning, no real timers, and no /proc reads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyLockHolder } from '../../../../.agents/scripts/lib/orchestration/story-close/phases/lock-wait-classifier.js';

const FIVE_MIN = 5 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const TWO_MIN = 2 * 60 * 1000;

const noopSleep = async () => undefined;
const NOW = 1_700_000_000_000;
const now = () => NOW;

describe('classifyLockHolder', () => {
  it("classifies a 30-minute-old holder doing 5 CPU-seconds per window as 'live'", async () => {
    // Arrange: 30-min-old process; each sample tick advances accumulated
    // CPU by 500 ms (~5 CPU-s across a 45 s window at 5 s cadence = 10
    // samples → 10 × 500 ms = 5_000 ms total delta).
    const pid = 4242;
    let cpuMs = 1_000_000;
    const probeCpuMs = () => {
      const value = cpuMs;
      cpuMs += 500;
      return value;
    };
    const probeStartTime = () => NOW - THIRTY_MIN;

    // Act
    const result = await classifyLockHolder(pid, {
      isAlive: () => true,
      probeStartTime,
      probeCpuMs,
      sleep: noopSleep,
      now,
    });

    // Assert
    assert.equal(result.verdict, 'live');
    assert.equal(result.reason, 'cpu-progress-observed');
    assert.ok(
      result.cpuDeltaMs >= 50,
      `expected non-trivial CPU delta, got ${result.cpuDeltaMs}`,
    );
  });

  it("classifies a 30-minute-old holder with 0 CPU across two windows as 'stale'", async () => {
    // Arrange: 30-min-old process; CPU probe always returns the same
    // accumulated value — no forward progress.
    const pid = 4343;
    const probeCpuMs = () => 2_000_000;
    const probeStartTime = () => NOW - THIRTY_MIN;

    // Act — run two consecutive windows; both must agree on 'stale'.
    const first = await classifyLockHolder(pid, {
      isAlive: () => true,
      probeStartTime,
      probeCpuMs,
      sleep: noopSleep,
      now,
    });
    const second = await classifyLockHolder(pid, {
      isAlive: () => true,
      probeStartTime,
      probeCpuMs,
      sleep: noopSleep,
      now,
    });

    // Assert
    assert.equal(first.verdict, 'stale');
    assert.equal(first.reason, 'no-cpu-progress');
    assert.equal(first.cpuDeltaMs, 0);
    assert.equal(second.verdict, 'stale');
    assert.equal(second.reason, 'no-cpu-progress');
  });

  it("treats a 2-minute-old holder with 0 CPU as 'live' (freshness gate wins)", async () => {
    // Arrange: just-spawned process. The freshness gate (default 5 min)
    // MUST short-circuit BEFORE the CPU probe runs — that probe being
    // consulted would be the bug that motivated Epic #2453's retro.
    const pid = 4444;
    let cpuProbeCalls = 0;
    const probeCpuMs = () => {
      cpuProbeCalls += 1;
      return 0;
    };
    const probeStartTime = () => NOW - TWO_MIN;

    // Act
    const result = await classifyLockHolder(pid, {
      isAlive: () => true,
      probeStartTime,
      probeCpuMs,
      sleep: noopSleep,
      now,
    });

    // Assert
    assert.equal(result.verdict, 'live');
    assert.equal(result.reason, 'freshness-gate');
    assert.equal(
      cpuProbeCalls,
      0,
      'CPU probe must not run when the freshness gate fires',
    );
    assert.ok(
      result.ageMs != null && result.ageMs < FIVE_MIN,
      `expected ageMs below the freshness threshold, got ${result.ageMs}`,
    );
  });
});
