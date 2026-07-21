/**
 * Unit tests for the `/search/issues` token-bucket budget (Story #4678).
 *
 * The bucket is pure and injectable: `now` and `sleep` are driven off a mutable
 * fake clock so the tests exercise the throttle and the rate-limit pause with
 * zero wall-clock time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSearchBudget, parseRateLimitResetMs } from '../search-budget.js';

/**
 * A deterministic clock: `now()` reads the current value; `sleep(ms)` advances
 * it and records the delay. No real timers.
 */
function fakeClock(start = 0) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
    sleeps,
  };
}

describe('createSearchBudget', () => {
  it('lets a burst up to capacity through without any wait', async () => {
    const clock = fakeClock();
    const budget = createSearchBudget({
      capacity: 3,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await budget.take();
    await budget.take();
    await budget.take();

    assert.deepEqual(clock.sleeps, [], 'no wait while tokens remain');
  });

  it('makes the caller wait for a token to accrue once the burst is spent', async () => {
    const clock = fakeClock();
    const budget = createSearchBudget({
      capacity: 2,
      windowMs: 1000, // 1 token accrues every 500ms
      now: clock.now,
      sleep: clock.sleep,
    });

    await budget.take();
    await budget.take();
    await budget.take(); // must wait for the third token

    assert.equal(clock.sleeps.length, 1, 'the over-capacity call waited once');
    assert.ok(clock.sleeps[0] >= 500, 'waited at least one refill interval');
  });

  it('pauses the whole batch once until the reported reset after a rate limit', async () => {
    const clock = fakeClock(1_000);
    const budget = createSearchBudget({
      capacity: 5,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await budget.take(); // one request goes out
    const resetAt = 1_000 + 30_000;
    budget.noteRateLimited(resetAt); // window is empty until reset

    await budget.take(); // the next call must pause until the reset

    assert.equal(clock.sleeps.length, 1, 'paused exactly once');
    assert.equal(clock.sleeps[0], 30_000, 'waited precisely until the reset');
    assert.equal(clock.now(), resetAt, 'clock advanced to the reset window');
  });

  it('falls back to a fixed cooldown when no reset time is reported', async () => {
    const clock = fakeClock(0);
    const budget = createSearchBudget({
      capacity: 5,
      windowMs: 1000,
      cooldownMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    budget.noteRateLimited(undefined);
    await budget.take();

    assert.equal(clock.sleeps[0], 60_000, 'waited the fixed cooldown');
  });
});

describe('parseRateLimitResetMs', () => {
  it('extracts an x-ratelimit-reset epoch from stderr as milliseconds', () => {
    const err = { stderr: 'HTTP 403\nx-ratelimit-reset: 1704067200\n' };
    assert.equal(parseRateLimitResetMs(err), 1_704_067_200 * 1000);
  });

  it('returns undefined when no reset header is present', () => {
    assert.equal(
      parseRateLimitResetMs({ message: 'rate limit exceeded' }),
      undefined,
    );
  });
});
