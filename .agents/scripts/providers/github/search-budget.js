/**
 * GitHub Provider — `/search/issues` fan-out budget (Story #4678).
 *
 * The 30-requests-per-minute cap is a property of GitHub's `/search/issues`
 * endpoint, not of any one caller. A single audit-to-stories scan issues ~2
 * search calls per finding; a 22-group scan therefore blows well past the cap
 * with no throttle of any kind, and every exhausted call then spends its whole
 * transient-retry budget re-issuing a request against an already-empty window.
 *
 * This module owns the throttle at the endpoint seam: a pure, injectable token
 * bucket that `IssuesGateway#searchIssues` awaits before every call, so every
 * caller (audit-to-stories dedup, `lib/duplicate-search.js`, the tickets
 * gateway's `_searchIssues`) inherits one shared budget for free.
 *
 * `now` and `sleep` are injected so unit tests drive the bucket deterministically
 * without wall-clock time.
 */

/**
 * Default budget: 30 tokens per 60s window, matching GitHub's authenticated
 * Search API cap. When a rate limit is reported with no readable reset, the
 * bucket pauses for one full window before the next `take()` resolves.
 */
const SEARCH_BUDGET_DEFAULTS = Object.freeze({
  capacity: 30,
  windowMs: 60_000,
  cooldownMs: 60_000,
});

/**
 * Create a token-bucket search budget.
 *
 * `take()` resolves once a token is available, consuming it; it awaits an
 * accruing token (and any active rate-limit cooldown) rather than failing.
 * `noteRateLimited(resetAtMs)` drains the bucket and blocks every subsequent
 * `take()` until the reported reset (or a fixed cooldown when no reset is
 * readable), so the whole batch pauses **once** instead of each call retrying
 * independently into the empty window.
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
      // Sleep just long enough for one token to accrue, then re-check.
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

/**
 * Process-wide singleton shared by every `searchIssues` caller. Per-process,
 * matching the one-scan-per-checkout model — there is deliberately no
 * cross-process budget.
 */
export const searchBudget = createSearchBudget();

/**
 * Best-effort extract of a rate-limit reset time (epoch ms) from a thrown
 * error's stderr. GitHub surfaces the reset as an `x-ratelimit-reset` epoch
 * (seconds) header; `gh` echoes response headers onto stderr on failure.
 * Returns `undefined` when no reset is readable so the bucket falls back to a
 * fixed cooldown. Pure — no I/O.
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
