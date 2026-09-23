/**
 * GitHub Provider — IssuesGateway: the raw GraphQL shim, epic reads, label
 * scans, branch probes, issue search, and the sub-ticket aggregator.
 */

import { GhRateLimitError } from '../../lib/gh-exec.js';
import { Logger } from '../../lib/Logger.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { isNotFoundError } from './branch-protection.js';
import { classifyGithubError, withTransientRetry } from './errors.js';
import { issueToEpic, issueToTicket, subIssueNodeToTicket } from './mappers.js';
import {
  defaultRetryWarn,
  paginateRest,
  parseApiJson,
} from './request-helpers.js';
import {
  searchBudget as defaultSearchBudget,
  parseRateLimitResetMs,
} from './search-budget.js';
import { composeBoundedQuery } from './search-query.js';

/**
 * Rate-limit is non-transient for search: the shared search budget owns the
 * wait, so retrying would only re-issue into an empty window.
 *
 * @param {unknown} err
 * @returns {string}
 */
function classifySearchRetry(err) {
  if (err instanceof GhRateLimitError) return 'rate-limited';
  return classifyGithubError(err);
}

export const SUBTICKET_HYDRATION_CONCURRENCY = 8;

/**
 * Node selection matches `SUB_ISSUES_QUERY` so `subIssueNodeToTicket` maps
 * parent and children alike; addressed by number to skip a node-id lookup.
 */
const PARENT_ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      parent {
        number
        databaseId
        id
        title
        body
        state
        labels(first: 30) { nodes { name } }
        assignees(first: 20) { nodes { login } }
      }
    }
  }
}`;

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
  constructor({ gh, owner, repo, hooks = {}, searchBudget } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
    this._hooks = hooks;
    // Process-wide singleton by default so all gateways share one 30/min
    // `/search/issues` window.
    this._searchBudget = searchBudget ?? defaultSearchBudget;
  }

  /**
   * Returns the response's `data`; throws on a non-empty `errors[]`.
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
   * Raw REST issues (PRs excluded); `labels` is GitHub's comma-separated form.
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
   * {@link listIssuesByLabel} mapped through `issueToTicket`, plus `url`.
   * Prefer this: on a raw payload `id` is the database id, on a mapped one it
   * is the issue number, and a `number ?? id` fallback silently mis-addresses.
   *
   * @param {{ state?: 'open'|'closed'|'all', labels?: string }} [opts]
   * @returns {Promise<Array<object>>} Mapped tickets (`id` is the issue number).
   * @field-manifest /repos/{owner}/{repo}/issues: number, id, node_id, title,
   *                 body, labels, state, state_reason, assignees, html_url,
   *                 pull_request
   */
  async listTicketsByLabel(opts = {}) {
    const issues = await this.listIssuesByLabel(opts);
    return issues.map((issue) => ({
      ...issueToTicket(issue),
      url: issue.html_url ?? null,
    }));
  }

  /**
   * Resolve an issue's container parent in one request via `Issue.parent`.
   * `null` means "no parent"; a degraded lookup throws after retries.
   *
   * @param {number} number Issue number whose parent to resolve.
   * @returns {Promise<object|null>} Mapped parent ticket, or null.
   * @throws {Error} When the lookup degrades.
   * @field-manifest GraphQL Issue.parent: number, id, title, body, state,
   *                 labels.nodes.name, assignees.nodes.login
   */
  async getParentIssue(number) {
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
    const data = await withTransientRetry(
      () =>
        this.ghGraphql(
          PARENT_ISSUE_QUERY,
          { owner: this.owner, repo: this.repo, number: issueNumber },
          { headers: { 'GraphQL-Features': 'sub_issues' } },
        ),
      {
        label: `getParentIssue #${issueNumber}`,
        onRetry: defaultRetryWarn,
      },
    );
    return subIssueNodeToTicket(data?.repository?.issue?.parent ?? null);
  }

  /**
   * Search issues (open and closed, so a closed match can surface as a
   * regression) in this repo via REST — not GraphQL, whose transient 401s
   * would make the dedup port silently no-op. Capped at one 100-item page;
   * `state` is lowercase.
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
    // Bounded here — the only place that sees both the free text and the
    // qualifiers — to Search's 256-char `q` limit.
    const qualifiers = [`repo:${scopeOwner}/${scopeRepo}`, 'type:issue'];
    const q = composeBoundedQuery(query, qualifiers);
    const params = new URLSearchParams({ q, per_page: '100' });
    const endpoint = `/search/issues?${params}`;
    await this._searchBudget.take();
    let result;
    try {
      result = await withTransientRetry(
        () => this._gh.api({ method: 'GET', endpoint }),
        {
          label: `searchIssues ${query}`,
          onRetry: defaultRetryWarn,
          classify: classifySearchRetry,
        },
      );
    } catch (err) {
      // Drain the budget until reset so the next call pauses once instead of
      // every caller retrying into the exhausted window.
      if (err instanceof GhRateLimitError) {
        this._searchBudget.noteRateLimited(parseRateLimitResetMs(err));
      }
      throw err;
    }
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
   * `false` only on 404; other errors propagate so auth failures don't
   * masquerade as a missing branch.
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

  _getChecklistChildren(parentBody) {
    const re = /-\s*\[[ xX]\]\s+#(\d+)/g;
    return [...(parentBody ?? '').matchAll(re)].map((m) =>
      Number.parseInt(m[1], 10),
    );
  }

  /** Reverse-search for issues referencing the parent; non-fatal on error. */
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
   * Union of native sub-issues and body checklist links; the full-repo
   * reverse search runs only when both are empty.
   *
   * @param {number} parentId
   * @param {{ fresh?: boolean }} [opts] - `fresh` bypasses the ticket cache
   *   for every child fetch.
   */
  async getSubTickets(parentId, opts = {}) {
    const getTicket = this._hooks.getTicket;
    const getNativeSubIssues = this._hooks.getNativeSubIssues;
    const parent = await getTicket(parentId);

    const [nativeChildIds, checklistChildIds] = await Promise.all([
      getNativeSubIssues(parent.nodeId, parentId),
      Promise.resolve(this._getChecklistChildren(parent.body)),
    ]);

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
