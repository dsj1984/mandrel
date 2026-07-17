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
 *   - Every `GIT_*` variable is dropped. When the suite runs inside a git
 *     hook (husky pre-push via the coverage-capture path), the parent git
 *     invocation exports `GIT_DIR` — from a linked worktree, the absolute
 *     `<main>/.git/worktrees/<name>` path. A test fixture's `git init`
 *     under that env re-initializes the shared gitdir and writes
 *     `core.bare=true` into the MAIN checkout's `.git/config`, breaking
 *     every worktree at once (#4580). Production git call sites are
 *     covered by `cleanGitEnv` in `git-utils.js`; this is the same scrub
 *     for test child processes, which may spawn git directly. Tests that
 *     need a `GIT_*` variable set it explicitly on their own spawn.
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function buildWebhookSafeTestEnv(baseEnv = process.env) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([k]) => !k.startsWith('GIT_')),
  );
  env.NODE_ENV = baseEnv.NODE_ENV ?? 'test';
  if (env.MANDREL_ALLOW_TEST_WEBHOOKS !== '1') {
    delete env.NOTIFICATION_WEBHOOK_URL;
  }
  return env;
}
