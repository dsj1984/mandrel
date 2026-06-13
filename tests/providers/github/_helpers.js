/**
 * Shared test helpers for the GitHubProvider facade contract tests.
 *
 * These helpers were extracted from the former root monolith
 * `tests/providers-github.test.js` (Story #4084) when its 54 facade-level
 * cases were split by API surface into `provider-*.test.js` siblings in this
 * directory. They drive `GitHubProvider` end-to-end through a faked gh-exec
 * facade (`makeGh`) and a faked global `fetch` (`createRouteMock`) — no live
 * network calls.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

export const { GitHubProvider } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'))
    .href
);
export const { ITicketingProvider } = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'lib', 'ITicketingProvider.js'),
  ).href
);
const { createGh } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

// ---------------------------------------------------------------------------
// gh-exec mock
//
// Story #1357 rebuilt the issue + comment surface on top of gh-exec, so tests
// inject a fake exec via `opts.gh = createGh(fakeExec)`. The fake routes on the
// argv shape `['api', '-X', <METHOD>, <ENDPOINT>, ...]` produced by
// `gh.api({ method, endpoint, body })`. Routes are keyed `"<METHOD> <ENDPOINT>
// fragment>"` matching the same `createRouteMock` ergonomic. Pagination
// (`paginateRest` in providers/github.js) appends `page=N&per_page=100`
// directly to the endpoint, so the route's `endpoint fragment` field is enough
// to match every page of a single list call.
// ---------------------------------------------------------------------------
export function createGhExec(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });

    // The `gh.api` facade builds argv as `['api', '-X', <METHOD>, <ENDPOINT>, ...]`.
    // The `gh.pr.*` / `gh.label.*` / `gh.repo.*` facades build
    // `[<noun>, <verb>, <target?>, ...flags]`. Disambiguate so a single mock
    // can carry both kinds of route (api routes are keyed
    // "<METHOD> <ENDPOINT>"; nounful routes are keyed
    // "<noun> <verb>"). Routes that look nounful (no leading HTTP verb) are
    // matched on `args[0] args[1]` and may optionally read the trailing
    // stdout payload from `response.stdout`.
    const noun = args[0];
    const isApi = noun === 'api';
    const method = isApi ? (args[2] ?? 'GET') : null;
    const endpoint = isApi ? (args[3] ?? '') : '';
    const bodyStr = input ?? '';

    let matched = null;
    for (const [pattern, response] of Object.entries(routes)) {
      const parts = pattern.split(' ');
      const head = parts[0];
      const second = parts[1] ?? '';
      const rest = parts.length > 2 ? parts.slice(2).join(' ') : null;

      // HTTP-method route (api path).
      const isHttpRoute = /^(GET|POST|PUT|PATCH|DELETE)$/.test(head);
      if (isHttpRoute) {
        if (!isApi) continue;
        if (
          method === head &&
          endpoint.includes(second) &&
          (!rest || bodyStr.includes(rest))
        ) {
          matched = response;
          break;
        }
        continue;
      }

      // Nounful route — `pr create`, `pr view`, `label list`, etc.
      if (noun === head && args[1] === second) {
        matched = response;
        break;
      }
    }
    const final = matched ?? { status: 200, json: {} };
    if (final.status >= 200 && final.status < 300) {
      // Nounful routes may override the canonical JSON-on-stdout shape with
      // a raw `stdout` string (e.g. `gh pr create` emits the URL plain).
      const stdout =
        typeof final.stdout === 'string'
          ? final.stdout
          : JSON.stringify(final.json ?? {});
      return { stdout, stderr: '', code: 0 };
    }
    // Non-2xx — gh exec rejects via classify(); for tests we throw a
    // shape-compatible Error so assertions on `/failed/` still match.
    const err = new Error(`gh-exec: gh exited with code ${final.status}`);
    err.code = final.status;
    err.stderr = JSON.stringify(final.json ?? '');
    err.stdout = '';
    throw err;
  };
  exec.calls = calls;
  return exec;
}

export function makeGh(routes) {
  const exec = createGhExec(routes);
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

export { createGh };

// ---------------------------------------------------------------------------
// Helpers — mock fetch
// ---------------------------------------------------------------------------

export function createRouteMock(routes) {
  const calls = [];

  const mockFn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const method = (opts.method || 'GET').toUpperCase();
    const bodyStr = opts.body || '';

    let matchedResponse = null;
    for (const [routePattern, response] of Object.entries(routes)) {
      const parts = routePattern.split(' ');
      const routeMethod = parts.length > 1 ? parts[0] : 'GET';
      const routePath = parts.length > 1 ? parts[1] : parts[0];
      const routeBodyMatcher =
        parts.length > 2 ? parts.slice(2).join(' ') : null;

      const methodMatches = method === routeMethod.toUpperCase();
      const pathMatches = url.includes(routePath);
      const bodyMatches =
        !routeBodyMatcher || bodyStr.includes(routeBodyMatcher);

      if (methodMatches && pathMatches && bodyMatches) {
        matchedResponse = response;
        break;
      }
    }

    const finalResponse = matchedResponse ?? { status: 200, json: {} };

    return {
      ok: finalResponse.status >= 200 && finalResponse.status < 300,
      status: finalResponse.status,
      headers: { get: () => null },
      json: async () => finalResponse.json,
      text: async () => JSON.stringify(finalResponse.json ?? ''),
    };
  };

  mockFn.calls = calls;
  return mockFn;
}

export function createTestProvider(opts = {}) {
  return new GitHubProvider(
    {
      owner: 'test-owner',
      repo: 'test-repo',
      projectNumber: opts.projectNumber ?? null,
      operatorHandle: '@tester',
    },
    { token: 'test-token-123', gh: opts.gh },
  );
}
