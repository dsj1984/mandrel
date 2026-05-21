/**
 * GitHub Provider — TicketGateway.
 *
 * Owns ticket CRUD against `/repos/{owner}/{repo}/issues` plus the
 * per-instance ticket cache that the dispatcher / reconciler / cascade
 * share. Extracted from `../github.js` in Story #2462 / Task #2482 as the
 * first slice of the seven-gateway split.
 *
 * The gateway is constructed with a `{ gh, owner, repo, hooks }` object so
 * cross-gateway concerns can be threaded in without bloating the constructor
 * signature. Today the only hooks the ticket surface reaches for are
 * `addSubIssue` (from the future SubIssueGateway, used by `createTicket` to
 * link a freshly-created child as a native sub-issue) and `addItemToProject`
 * (from the projects-v2 shim, used by `createTicket` to add the new issue
 * to the configured Project V2).
 *
 * Public surface is unchanged: `GitHubProvider.createTicket / getTicket /
 * getTickets / updateTicket / getTicketDependencies / primeTicketCache /
 * invalidateTicket` all delegate to the same-named methods on this class.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { parseBlockedBy, parseBlocks } from '../../lib/dependency-parser.js';
import { Logger } from '../../lib/Logger.js';
import { composeTaskBody } from '../../lib/templates/task-body-renderer.js';
import { createInlineTicketCache } from './cache.js';
import { withTransientRetry } from './errors.js';
import { issueToListItem, issueToTicket } from './mappers.js';
import {
  defaultRetryWarn,
  paginateRest,
  parseApiJson,
} from './request-helpers.js';

export class TicketGateway {
  /**
   * @param {{
   *   gh: object,
   *   owner: string,
   *   repo: string,
   *   hooks?: {
   *     addSubIssue?: (parentNumber: number, childNodeId: string) => Promise<unknown>,
   *     addItemToProject?: (nodeId: string) => Promise<unknown>,
   *     getProjectNumber?: () => number|null,
   *   },
   *   cache?: ReturnType<typeof createInlineTicketCache>,
   * }} deps
   */
  constructor({ gh, owner, repo, hooks = {}, cache } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
    this._hooks = hooks;
    this._cache = cache ?? createInlineTicketCache();
  }

  /**
   * Expose the cache so the parent provider's other surfaces (sub-issues,
   * comments) can keep invalidating on mutations. The parent passes the
   * same cache instance into every gateway constructor.
   */
  get cache() {
    return this._cache;
  }

  // ---------------------------------------------------------------------------
  // Read surface
  // ---------------------------------------------------------------------------

  /**
   * @field-manifest /repos/{owner}/{repo}/issues/{n}: number, id, node_id,
   *                 title, body, labels, assignees, state
   */
  async getTicket(ticketId, opts = {}) {
    if (!opts.fresh) {
      if (Number.isFinite(opts.maxAgeMs)) {
        const fresh = this._cache.peekFresh(ticketId, opts.maxAgeMs);
        if (fresh !== undefined) return fresh;
      } else if (this._cache.has(ticketId)) {
        return this._cache.peek(ticketId);
      }
    }
    const result = await withTransientRetry(
      () =>
        this._gh.api({
          method: 'GET',
          endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}`,
        }),
      { label: `getTicket #${ticketId}`, onRetry: defaultRetryWarn },
    );
    const ticket = issueToTicket(parseApiJson(result));
    this._cache.set(ticketId, ticket);
    return ticket;
  }

  /**
   * @field-manifest /repos/{owner}/{repo}/issues?state=...&labels=...:
   *                 number, body, labels, state, pull_request
   */
  /* node:coverage ignore next */
  async getTickets(epicId, filters = {}) {
    const params = new URLSearchParams({ state: filters.state ?? 'all' });
    if (filters.label) params.set('labels', filters.label);

    const endpoint = `/repos/${this.owner}/${this.repo}/issues?${params}`;
    const issues = await paginateRest(this._gh, endpoint);

    // Word-boundary regex prevents #1 matching #10, #100, etc.
    const epicRefRe = new RegExp(
      `(?:Epic:\\s*#${epicId}|parent:\\s*#${epicId})(?:\\s|$|[,.)\\]])`,
    );

    return issues
      .filter((issue) => {
        if (issue.pull_request) return false;
        const body = issue.body ?? '';
        return epicRefRe.test(body);
      })
      .map(issueToListItem);
  }

  /* node:coverage ignore next */
  async getTicketDependencies(ticketId) {
    const ticket = await this.getTicket(ticketId);
    return {
      blocks: parseBlocks(ticket.body),
      blockedBy: parseBlockedBy(ticket.body),
    };
  }

  // ---------------------------------------------------------------------------
  // Cache primers — exposed so the parent provider keeps a stable surface for
  // `primeTicketCache` / `invalidateTicket` callers.
  // ---------------------------------------------------------------------------

  primeTicketCache(tickets) {
    this._cache.primeMany(tickets);
  }

  invalidateTicket(ticketId) {
    this._cache.invalidate(ticketId);
  }

  // ---------------------------------------------------------------------------
  // Write surface
  // ---------------------------------------------------------------------------

  /**
   * Create a new issue. Renders the body via `composeTaskBody` so the
   * `parent: #N` / `Epic: #M` footer is consistent across creators.
   *
   * After the POST, opportunistically link the child as a native sub-issue
   * (via the `addSubIssue` hook — retried internally on the sub-issue
   * gateway) and add it to the configured Project V2 (best-effort —
   * failures warn but do not fail the create).
   *
   * @field-manifest POST /repos/{owner}/{repo}/issues: number, id, node_id,
   *                 html_url
   */
  /* node:coverage ignore next */
  async createTicket(parentId, ticketData) {
    const epicId = ticketData.epicId || parentId;
    const renderedBody = composeTaskBody({
      body: ticketData.body ?? '',
      parentId,
      epicId,
      dependencies: ticketData.dependencies ?? [],
      auditSnapshot: ticketData.auditSnapshot,
    });

    const result = await this._gh.api({
      method: 'POST',
      endpoint: `/repos/${this.owner}/${this.repo}/issues`,
      body: {
        title: ticketData.title,
        body: renderedBody,
        labels: ticketData.labels ?? [],
      },
    });
    const issue = parseApiJson(result);

    let subIssueLinked = false;
    let subIssueError = null;
    try {
      if (typeof this._hooks.addSubIssue === 'function') {
        await this._hooks.addSubIssue(parentId, issue.node_id);
        subIssueLinked = true;
      }
    } catch (err) {
      subIssueError = err;
    }

    try {
      const projectNumber =
        typeof this._hooks.getProjectNumber === 'function'
          ? this._hooks.getProjectNumber()
          : null;
      if (projectNumber && typeof this._hooks.addItemToProject === 'function') {
        await this._hooks.addItemToProject(issue.node_id);
      }
    } catch (err) {
      Logger.warn(
        `[GitHubProvider] Failed to add Issue #${issue.number} to project: ${err.message}`,
      );
    }

    return {
      id: issue.number,
      internalId: issue.id,
      nodeId: issue.node_id,
      url: issue.html_url,
      subIssueLinked,
      subIssueError,
    };
  }

  /**
   * Add/remove labels on an issue. When the only mutation is "add", uses the
   * additive labels endpoint (POST /issues/{n}/labels) for atomicity and to
   * avoid a read-before-write. When other PATCH fields are present, or when
   * removing labels, computes the final label set and returns it to the
   * caller for inclusion in the PATCH.
   */
  async _applyLabelMutations(
    ticketId,
    labelMutations,
    hasOtherPatchFields,
    ticketSnapshot = null,
  ) {
    const { add = [], remove = [] } = labelMutations;

    if (add.length > 0 && remove.length === 0 && !hasOtherPatchFields) {
      await this._gh.api({
        method: 'POST',
        endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}/labels`,
        body: { labels: add },
      });
      return { skipPatch: true };
    }

    // Story #1795 — when `transitionTicketState` threads a pre-fetched
    // snapshot via `_ticketSnapshot` we reuse its labels rather than
    // issuing another `getTicket` for the merge.
    const ticket = ticketSnapshot ?? (await this.getTicket(ticketId));
    const currentLabels = new Set(ticket.labels ?? []);
    for (const l of remove) currentLabels.delete(l);
    for (const l of add) currentLabels.add(l);

    return { skipPatch: false, mergedLabels: Array.from(currentLabels) };
  }

  /**
   * @field-manifest PATCH /repos/{owner}/{repo}/issues/{n}:
   *                 body, assignees, state, state_reason, labels
   */
  /* node:coverage ignore next */
  async updateTicket(ticketId, mutations) {
    const patch = {};
    if (mutations.body !== undefined) patch.body = mutations.body;
    if (mutations.assignees) patch.assignees = mutations.assignees;
    if (mutations.state !== undefined) patch.state = mutations.state;
    if (mutations.state_reason !== undefined)
      patch.state_reason = mutations.state_reason;

    if (mutations.labels) {
      const hasOtherPatchFields = Object.keys(patch).length > 0;
      const result = await this._applyLabelMutations(
        ticketId,
        mutations.labels,
        hasOtherPatchFields,
        mutations._ticketSnapshot ?? null,
      );
      if (result.skipPatch) {
        this.invalidateTicket(ticketId);
        return;
      }
      patch.labels = result.mergedLabels;
    }

    if (Object.keys(patch).length > 0) {
      await this._gh.api({
        method: 'PATCH',
        endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}`,
        body: patch,
      });
      this.invalidateTicket(ticketId);
    }
  }
}
