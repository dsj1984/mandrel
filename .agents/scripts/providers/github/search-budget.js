/**
 * GitHub Provider — token-bucket throttle for `/search/issues`, whose
 * 30/min cap belongs to the endpoint, not any caller. `searchIssues` awaits
 * it before every call so all callers share one budget.
 */

/** GitHub's authenticated Search cap; cooldown applies when no reset is readable. */
const SEARCH_BUDGET_DEFAULTS = Object.freeze({
  capacity: 30,
  windowMs: 60_000,
  cooldownMs: 60_000,
});

/**
 * `take()` waits for (never fails on) a token. `noteRateLimited` drains the
 * bucket and blocks every `take()` until the reset, so the batch pauses once
 * instead of each call retrying into the empty window.
 *
 * @param {object} [opts]
 * @param {number} [opts.capacity] — max tokens (and burst size).
 * @param {number} [opts.windowMs] — window over which `capacity` tokens accrue.
 * @param {number} [opts.cooldownMs] — pause applied when a rate limit reports
 *   no readable reset time.
 * @param {() => number} [opts.now] — millisecond clock (injected for tests).
 * @param {(ms: number) => Promise<void>} [opts.sleep] — delay primitive.
 * @returns {{ take: () => Promise<void>, noteRateLimited: (resetAtMs?: number) => void }}
 */
export function createSearchBudget({
  capacity = SEARCH_BUDGET_DEFAULTS.capacity,
  windowMs = SEARCH_BUDGET_DEFAULTS.windowMs,
  cooldownMs = SEARCH_BUDGET_DEFAULTS.cooldownMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const refillPerMs = capacity / windowMs;
  let tokens = capacity;
  let lastRefillAt = now();
  let blockedUntil = 0;

  function refill() {
    const at = now();
    const elapsed = at - lastRefillAt;
    if (elapsed > 0) {
      tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
      lastRefillAt = at;
    }
  }

  async function take() {
    for (;;) {
      const at = now();
      if (blockedUntil > at) {
        await sleep(blockedUntil - at);
        continue;
      }
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((1 - tokens) / refillPerMs));
      await sleep(waitMs);
    }
  }

  function noteRateLimited(resetAtMs) {
    const at = now();
    tokens = 0;
    lastRefillAt = at;
    const until =
      typeof resetAtMs === 'number' && resetAtMs > at
        ? resetAtMs
        : at + cooldownMs;
    if (until > blockedUntil) blockedUntil = until;
  }

  return { take, noteRateLimited };
}

/** Per-process by design (one scan per checkout); no cross-process budget. */
export const searchBudget = createSearchBudget();

/**
 * The `x-ratelimit-reset` header (epoch seconds) `gh` echoes onto stderr.
 *
 * @param {unknown} err
 * @returns {number|undefined} reset time in epoch milliseconds, or undefined.
 */
export function parseRateLimitResetMs(err) {
  const haystack = [err?.stderr, err?.message].filter(Boolean).join('\n');
  const match = haystack.match(/x-ratelimit-reset:\s*(\d{10})/i);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10) * 1000;
}
