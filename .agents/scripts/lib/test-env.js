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
 *     deliberately exercising a sandbox endpoint).
 *   - `NODE_ENV=test` is set so the library-level guard in `notify.js`
 *     can refuse webhook delivery when the caller did not explicitly opt
 *     in via `opts.webhookUrl`. Defense-in-depth: if a future test entry
 *     point bypasses this scrub (e.g., `node --test` invoked directly),
 *     the library guard still catches it.
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
