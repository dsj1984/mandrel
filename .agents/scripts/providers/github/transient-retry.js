/**
 * transient-retry — shared retry-with-backoff for GitHub provider calls.
 *
 * Resilience for flaky connections (e.g. cell hotspots): retry ONLY on
 * connectivity blips, never on auth / scope / not-found / already-exists /
 * validation errors. Works for both surfaces the provider uses:
 *   - the gh CLI path — errors carry the Go HTTP error on `err.stderr`
 *     (e.g. `dial tcp ...: i/o timeout`); and
 *   - the direct `fetch` path — errors are a `TypeError: fetch failed` with
 *     the real reason on `err.cause` (e.g. `ETIMEDOUT`, `ENOTFOUND`).
 *
 * Retrying a non-idempotent create is acceptable for the dominant hotspot
 * failure (`dial tcp ... i/o timeout` means the connection never opened, so
 * the request never reached GitHub). Callers still gate retry per call so
 * the genuinely non-idempotent project-create can opt out.
 */

const TRANSIENT_RE =
  /i\/o timeout|dial tcp|TLS handshake timeout|connection reset|connection refused|temporary failure|could not resolve host|no such host|network is unreachable|socket hang up|fetch failed|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|\b50[234]\b/i;

/** True when an error looks like a retryable network/connectivity blip. */
export function isTransientNetworkError(err) {
  const hay = [
    err?.stderr,
    err?.message,
    err?.code,
    err?.cause?.message,
    err?.cause?.code,
  ]
    .filter(Boolean)
    .join(' ');
  return TRANSIENT_RE.test(hay);
}

/**
 * Run `fn`, retrying with exponential backoff ONLY on transient network
 * errors (1s, 2s, 4s by default). Non-transient errors throw immediately so
 * real failures stay loud. `sleep` is injectable for tests.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(
  fn,
  {
    retries = 3,
    baseDelayMs = 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientNetworkError(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}
