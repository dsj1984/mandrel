/**
 * GitHub Provider — IssuesGateway.
 *
 * Owns the remaining read-side surface that did not belong to any of the
 * earlier six gateways: the raw GraphQL shim (`graphql` / `_ghGraphql`),
 * epic reads (`getEpic`), repository-wide label scans
 * (`listIssuesByLabel`), branch existence probes (`branchExists`), and the
 * three-strategy sub-ticket aggregator (`getSubTickets`).
 *
 * Extracted from `../github.js` in Story #2462 / Task #2481 — the final
 * slice that brings `GitHubProvider` down to a thin composition root.
 * Public surface on `GitHubProvider` is unchanged: every method here is
 * exposed by a one-line delegating wrapper on the parent provider.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { Logger } from '../../lib/Logger.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { isNotFoundError } from './branch-protection.js';
import { withTransientRetry } from './errors.js';
import { issueToEpic } from './mappers.js';
import {
  defaultRetryWarn,
  paginateRest,
  parseApiJson,
} from './request-helpers.js';

/**
 * Concurrency budget for the `getSubTickets` fan-out — preserved from
 * the old `./github/issues.js` predecessor.
 */
export const SUBTICKET_HYDRATION_CONCURRENCY = 8;

// Re-export so existing test consumers that previously imported
// `paginateRest` from this module continue to work without an extra
// migration step.
export { paginateRest };

export class IssuesGateway {
  /**
   * @param {{
   *   gh: object,
   *   owner: string,
   *   repo: string,
   *   hooks?: {
   *     getTicket?: (id: number, opts?: object) => Promise<object>,
   *     getTickets?: (parentId: number) => Promise<object[]>,
   *     getNativeSubIssues?: (parentNodeId: string, parentId: number) => Promise<number[]>,
   *     primeTicketCache?: (tickets: object[]) => void,
   *   },
   * }} deps
   */
  constructor({ gh, owner, repo, hooks = {} } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
    this._hooks = hooks;
  }

  /**
   * Run a GraphQL query/mutation through `gh api graphql` (POST with a
   * JSON `{ query, variables }` body on stdin). Returns the `data` field.
   * Throws when the response contains a non-empty `errors[]`.
   */
  async ghGraphql(query, variables = {}, _opts = {}) {
    const body = { query };
    if (variables && Object.keys(variables).length > 0) {
      body.variables = variables;
    }
    const result = await this._gh.api({
      method: 'POST',
      endpoint: 'graphql',
      body,
    });
    const json = JSON.parse(result?.stdout ?? '{}');
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(
        `[GitHubProvider] GraphQL errors: ${JSON.stringify(json.errors)}`,
      );
    }
    return json.data;
  }

  /**
   * List every issue carrying `labels` (comma-separated string per GitHub
   * REST). Used by the dispatcher / reconciler to scan for `agent::*`
   * state.
   *
   * @field-manifest /repos/{owner}/{repo}/issues: number, title, body, labels,
   *                 state, assignees, pull_request
   */
  async listIssuesByLabel({ state = 'open', labels: labelFilter } = {}) {
    const params = new URLSearchParams({ state });
    if (labelFilter) params.set('labels', labelFilter);
    const endpoint = `/repos/${this.owner}/${this.repo}/issues?${params}`;
    const issues = await paginateRest(this._gh, endpoint);
    return issues.filter((issue) => !issue?.pull_request);
  }

  /**
   * Search issues by a free-text query via the REST search API
   * (`GET /search/issues`). Deliberately REST, **not** GraphQL: transient
   * GraphQL 401s are a known failure mode in this repo (the dedup port that
   * consumes this method must not silently no-op on an auth blip), so the
   * search rides the same `gh api` REST surface + transient-retry shim as
   * every other read here.
   *
   * The caller (`audit-to-stories.js` `loadProvider()`) passes a 40-char
   * fingerprint sha as the query so the search resolves the handful of
   * issues whose fingerprint footer carries that sha; `route-finding.js`
   * then confirms identity against the footer. Both open and closed issues
   * are returned (no `state:` qualifier is appended) so a closed-fingerprint
   * match can surface as `regression-of-closed`.
   *
   * Returns the trimmed `[{ number, state, body, title, html_url }]`
   * projection. Dedup callers use `{ number, state, body }`; duplicate-
   * search also needs `title` / `html_url`. `state` is normalised to the
   * REST lowercase form (`open` / `closed`). Results are capped at one
   * Search API page (`per_page=100`).
   *
   * @param {{ query: string, owner?: string, repo?: string }} params
   * @returns {Promise<Array<{ number: number, state: string, body: string, title: string, html_url?: string }>>}
   * @field-manifest GET /search/issues: total_count, items[number, state, body, title, html_url]
   */
  async searchIssues({ query, owner, repo } = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('searchIssues: a non-empty query string is required');
    }
    const scopeOwner = owner ?? this.owner;
    const scopeRepo = repo ?? this.repo;
    // Constrain the search to this repo and to issues (not PRs). The
    // fingerprint sha is the free-text term; GitHub matches it against the
    // issue body where the `<!-- audit-fingerprints: ... -->` footer lives.
    const qualifiers = [`repo:${scopeOwner}/${scopeRepo}`, 'type:issue'];
    const q = `${query.trim()} ${qualifiers.join(' ')}`;
    const params = new URLSearchParams({ q, per_page: '100' });
    const endpoint = `/search/issues?${params}`;
    const result = await withTransientRetry(
      () => this._gh.api({ method: 'GET', endpoint }),
      { label: `searchIssues ${query}`, onRetry: defaultRetryWarn },
    );
    const json = parseApiJson(result);
    const items = Array.isArray(json?.items) ? json.items : [];
    return items.map((item) => ({
      number: item.number,
      state: item.state ?? 'open',
      body: item.body ?? '',
      title: item.title ?? '',
      html_url: item.html_url ?? undefined,
    }));
  }

  /**
   * @field-manifest /repos/{owner}/{repo}/issues/{n}: number, id, node_id,
   *                 title, body, labels, state
   */
  async getEpic(epicId) {
    const result = await withTransientRetry(
      () =>
        this._gh.api({
          method: 'GET',
          endpoint: `/repos/${this.owner}/${this.repo}/issues/${epicId}`,
        }),
      { label: `getEpic #${epicId}`, onRetry: defaultRetryWarn },
    );
    return issueToEpic(parseApiJson(result));
  }

  /**
   * Probe whether `branch` exists on the remote. Returns `true` when the
   * branch resolves, `false` on 404, and propagates any other transport
   * error so auth/scope failures don't masquerade as a missing branch.
   *
   * @field-manifest GET /repos/{owner}/{repo}/branches/{branch}: name
   */
  async branchExists(branch) {
    const endpoint = `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}`;
    try {
      await withTransientRetry(
        () => this._gh.api({ method: 'GET', endpoint }),
        { label: `branchExists ${branch}`, onRetry: defaultRetryWarn },
      );
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  /** Strategy 2 — Markdown checklist links `- [ ] #N` / `- [x] #N`. */
  _getChecklistChildren(parentBody) {
    const re = /-\s*\[[ xX]\]\s+#(\d+)/g;
    return [...(parentBody ?? '').matchAll(re)].map((m) =>
      Number.parseInt(m[1], 10),
    );
  }

  /**
   * Strategy 3 — reverse-search for issues that reference the parent
   * (`Epic: #N` / `parent: #N`). Non-fatal on error.
   */
  async _getReferencedChildren(parentId) {
    const getTickets = this._hooks.getTickets;
    const primeTicketCache = this._hooks.primeTicketCache;
    try {
      const issues = await getTickets(parentId);
      if (typeof primeTicketCache === 'function') {
        primeTicketCache(issues);
      }
      return issues.map((i) => i.id);
    } catch (err) {
      Logger.warn(
        `[GitHubProvider] reverse dependency lookup (parent #${parentId}): ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Aggregate sub-tickets via a priority-fallback strategy:
   *   1. Native sub-issues (GraphQL) + checklist links in body — run in
   *      parallel because checklist parsing is pure/synchronous.
   *   2. Reverse-search (`_getReferencedChildren`) — a full-repo label
   *      scan that is **only** executed when both strategy 1 sources
   *      return empty. This avoids the unconditional full-repo scan that
   *      fired on every call in the old `Promise.all` path.
   *
   * @param {number} parentId
   * @param {{ fresh?: boolean }} [opts] - Pass `{ fresh: true }` to bypass
   *   the per-instance ticket cache for every child hydration fetch. Used
   *   by the cascade logic to skip a redundant second fan-out.
   */
  async getSubTickets(parentId, opts = {}) {
    const getTicket = this._hooks.getTicket;
    const getNativeSubIssues = this._hooks.getNativeSubIssues;
    const parent = await getTicket(parentId);

    // Strategy 1: native sub-issues (GraphQL) + checklist (synchronous).
    const [nativeChildIds, checklistChildIds] = await Promise.all([
      getNativeSubIssues(parent.nodeId, parentId),
      Promise.resolve(this._getChecklistChildren(parent.body)),
    ]);

    // Strategy 2 (fallback): full-repo reverse-search — only when strategy
    // 1 produced nothing, avoiding the unconditional scan on every call.
    let referencedChildIds = [];
    if (nativeChildIds.length === 0 && checklistChildIds.length === 0) {
      referencedChildIds = await this._getReferencedChildren(parentId);
    }

    const allChildIds = [
      ...new Set([
        ...nativeChildIds,
        ...checklistChildIds,
        ...referencedChildIds,
      ]),
    ];

    const ticketOpts = opts.fresh ? { fresh: true } : undefined;
    const subTickets = await concurrentMap(
      allChildIds,
      (id) =>
        getTicket(id, ticketOpts).catch((err) => {
          const msg = err?.message ?? String(err);
          Logger.warn(
            `[GitHubProvider] getSubTickets: child #${id} fetch failed (parent #${parentId}): ${msg}`,
          );
          return null;
        }),
      { concurrency: SUBTICKET_HYDRATION_CONCURRENCY },
    );
    return subTickets.filter(Boolean);
  }
}
