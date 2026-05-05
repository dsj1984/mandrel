/**
 * GithubHttpClient — low-level GitHub REST + GraphQL transport.
 *
 * Extracted from providers/github.js so the transport layer (token handling,
 * retry/backoff, pagination, URL construction) can be unit-tested in isolation
 * from the ticketing domain logic. The provider composes this client and
 * exposes the four proxy methods (_rest, _restPaginated, _graphql, token)
 * for backwards compatibility with existing call sites and tests.
 */

import { Logger } from '../lib/Logger.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

// GitHub's secondary rate limit returns HTTP 403 with a body string containing
// the phrase "secondary rate limit" (or "abuse detection mechanism" on older
// docs). It is distinct from the primary rate limit (HTTP 429) and trips on
// content-creation bursts well before any documented hourly quota — large
// Epic decompositions (~80 issue creations in a few seconds) reproduce it.
const SECONDARY_RL_PATTERN = /secondary rate limit|abuse detection/i;

const SECONDARY_RL_BASE_DELAY_MS = 30000;
const SECONDARY_RL_MAX_DELAY_MS = 120000;
const SECONDARY_RL_JITTER_MS = 5000;

export class GithubHttpClient {
  /**
   * @param {object} opts
   * @param {() => string} opts.tokenProvider  Lazy token resolver.
   * @param {typeof fetch} [opts.fetchImpl]    Injectable fetch for testing.
   * @param {(info: { kind: string, url: string, status: number }) => void} [opts.onTransientFailure]
   *   Callback fired each time a request is retried due to a transient
   *   failure (429, 5xx, secondary RL). Used by callers like the ticket
   *   decomposer to drop concurrency adaptively after the first observation.
   */
  constructor({ tokenProvider, fetchImpl, onTransientFailure } = {}) {
    this._tokenProvider = tokenProvider;
    this._fetch = fetchImpl ?? ((...args) => fetch(...args));
    this._token = null;
    this.onTransientFailure = onTransientFailure ?? null;
  }

  get token() {
    if (!this._token) {
      this._token = this._tokenProvider();
    }
    return this._token;
  }

  _emitTransient(info) {
    if (typeof this.onTransientFailure === 'function') {
      try {
        this.onTransientFailure(info);
      } catch {
        // Listener errors must never derail the retry loop.
      }
    }
  }

  /**
   * Fetch with exponential backoff retry for transient failures.
   * Retries on:
   *   - 429 (primary rate limit)
   *   - 5xx (server errors)
   *   - 403 + body matching SECONDARY_RL_PATTERN (secondary RL — abuse
   *     detection). Generic 403s (auth failure, "Resource not accessible by
   *     integration", SSO denial, etc.) are NOT retried; the body is surfaced
   *     to the caller untouched.
   *   - network errors thrown by `fetch`.
   *
   * Returns `{ res, bodyText }`. For ok responses bodyText is null and the
   * caller is expected to consume `res.json()`. For non-ok responses bodyText
   * is the already-read body — readers must NOT call `res.text()` again.
   */
  async _fetchWithRetry(url, fetchOpts, maxRetries = 5) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this._fetch(url, fetchOpts);
        if (res.ok || res.status === 204) return { res, bodyText: null };

        const bodyText = await res.text().catch(() => '');
        const isSecondaryRL =
          res.status === 403 && SECONDARY_RL_PATTERN.test(bodyText);
        const transient =
          res.status === 429 || res.status >= 500 || isSecondaryRL;

        if (!transient || attempt === maxRetries) {
          return { res, bodyText };
        }

        const retryAfter = Number.parseInt(
          res.headers.get('retry-after') || '0',
          10,
        );
        let delay;
        if (retryAfter > 0) {
          delay = retryAfter * 1000;
        } else if (isSecondaryRL) {
          // Secondary RL is sticky — back off harder than the regular path.
          const base = Math.min(
            SECONDARY_RL_MAX_DELAY_MS,
            SECONDARY_RL_BASE_DELAY_MS * 2 ** attempt,
          );
          delay = base + Math.floor(Math.random() * SECONDARY_RL_JITTER_MS);
        } else {
          delay = 2 ** attempt * 1000;
        }
        const kind = isSecondaryRL
          ? 'secondary-rate-limit'
          : res.status === 429
            ? 'rate-limit'
            : 'server-error';
        Logger.warn(
          `[GitHubProvider] ${kind} (${res.status}) on ${url} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
        );
        this._emitTransient({ kind, url, status: res.status });
        await new Promise((r) => setTimeout(r, delay));
      } catch (err) {
        if (attempt === maxRetries) throw err;
        const delay = 2 ** attempt * 1000;
        Logger.warn(
          `[GitHubProvider] Network error on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delay}ms: ${err.message}`,
        );
        this._emitTransient({ kind: 'network', url, status: 0 });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error('[GitHubProvider] Retry loop exhausted without response');
  }

  async rest(endpoint, opts = {}) {
    const url = `${GITHUB_API}${endpoint}`;
    const method = opts.method ?? 'GET';

    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'node.js',
    };

    const fetchOpts = { method, headers };
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const { res, bodyText } = await this._fetchWithRetry(url, fetchOpts);

    if (!res.ok) {
      throw new Error(
        `[GitHubProvider] ${method} ${endpoint} failed (${res.status}): ${bodyText ?? ''}`,
      );
    }

    if (res.status === 204) return null;
    return res.json();
  }

  async restPaginated(endpoint) {
    const allItems = [];
    const separator = endpoint.includes('?') ? '&' : '?';
    let page = 1;
    while (true) {
      const batch = await this.rest(
        `${endpoint}${separator}page=${page}&per_page=100`,
      );
      if (!Array.isArray(batch)) break;
      allItems.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return allItems;
  }

  async graphql(query, variables = {}, opts = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'node.js',
      ...opts.headers,
    };

    const { res, bodyText } = await this._fetchWithRetry(GITHUB_GRAPHQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(
        `[GitHubProvider] GraphQL request failed (${res.status}): ${bodyText ?? ''}`,
      );
    }

    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(
        `[GitHubProvider] GraphQL errors: ${JSON.stringify(json.errors)}`,
      );
    }

    return json.data;
  }
}
