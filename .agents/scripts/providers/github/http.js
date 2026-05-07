/**
 * GitHub HTTP transport — REST request helpers.
 *
 * Owns the low-level GitHub REST transport: token-bearing headers, retry/
 * backoff, pagination, and URL construction. The `GithubHttpClient` class
 * implementation lives at `providers/github/http-client.js` alongside the
 * other provider internals; this module is preserved as the public path
 * for back-compat.
 *
 * Submodules under `providers/github/` consume this transport via
 * `ctx.http.{rest,restPaginated}` — they never reach for a sibling submodule.
 */

export { GithubHttpClient } from './http-client.js';
