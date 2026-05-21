/**
 * GitHub Provider — IssuesGateway.
 *
 * Owns the remaining read-side surface that did not belong to any of the
 * earlier six gateways: the raw GraphQL shim (`graphql` / `_ghGraphql`),
 * epic enumeration (`getEpics`, `getEpic`), repository-wide label scans
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
import { TYPE_LABELS } from '../../lib/label-constants.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { isNotFoundError } from './branch-protection.js';
import { withTransientRetry } from './errors.js';
import { issueToEpic, issueToEpicListItem } from './mappers.js';
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
   * REST). Used by orchestration to scan for `agent::*` state.
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
   * List Epic-typed issues. Filter shape preserved from the old code.
   *
   * @field-manifest /repos/{owner}/{repo}/issues?labels=type::epic: number,
   *                 title, labels, state, state_reason, pull_request
   */
  /* node:coverage ignore next */
  async getEpics(filters = {}) {
    const params = new URLSearchParams({
      state: filters.state ?? 'all',
      labels: TYPE_LABELS.EPIC,
    });
    const endpoint = `/repos/${this.owner}/${this.repo}/issues?${params}`;
    const issues = await paginateRest(this._gh, endpoint);
    return issues
      .filter((issue) => !issue.pull_request)
      .map(issueToEpicListItem);
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
   * Aggregate sub-tickets via the three-strategy fallback: native
   * sub-issues (GraphQL) → checklist links in body → reverse-search.
   * Deduped while preserving the historical fallback order.
   */
  async getSubTickets(parentId) {
    const getTicket = this._hooks.getTicket;
    const getNativeSubIssues = this._hooks.getNativeSubIssues;
    const parent = await getTicket(parentId);
    const [nativeChildIds, checklistChildIds, referencedChildIds] =
      await Promise.all([
        getNativeSubIssues(parent.nodeId, parentId),
        Promise.resolve(this._getChecklistChildren(parent.body)),
        this._getReferencedChildren(parentId),
      ]);

    const allChildIds = [
      ...new Set([
        ...nativeChildIds,
        ...checklistChildIds,
        ...referencedChildIds,
      ]),
    ];

    const subTickets = await concurrentMap(
      allChildIds,
      (id) =>
        getTicket(id).catch((err) => {
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
