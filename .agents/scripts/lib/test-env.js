/**
 * Build a webhook-safe child-process environment for test runners.
 *
 * Operators keep a real `NOTIFICATION_WEBHOOK_URL` in `.env` for development
 * (the production `notify()` path reads it via `process.env` after
 * `resolveConfig()` calls `loadEnv()`). Without scrubbing, any test that
 * transitively reaches `notify()` POSTs to the live endpoint.
 *
 * This helper produces the env bag that test child processes inherit:
 *
 *   - `NOTIFICATION_WEBHOOK_URL` is deleted unless the operator opted in
 *     via `MANDREL_ALLOW_TEST_WEBHOOKS=1` (e.g., a contract test
 *     deliberately exercising a sandbox endpoint). With the URL scrubbed,
 *     `resolveWebhookUrl()` returns nothing and `notify()` never POSTs.
 *   - `NODE_ENV=test` is set for the rest of the suite's environment
 *     expectations. (It no longer gates `notify()`'s webhook delivery —
 *     the NODE_ENV band-aid was removed in Story #3342. Tests that need to
 *     exercise the webhook POST inject `opts.fetchImpl` instead, so the
 *     request never reaches the real network even if a URL resolves.)
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function buildWebhookSafeTestEnv(baseEnv = process.env) {
  const env = { ...baseEnv, NODE_ENV: baseEnv.NODE_ENV ?? 'test' };
  if (env.MANDREL_ALLOW_TEST_WEBHOOKS !== '1') {
    delete env.NOTIFICATION_WEBHOOK_URL;
  }
  return env;
}
