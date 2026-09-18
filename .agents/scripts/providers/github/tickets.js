/**
 * GitHub Provider — TicketGateway: issue CRUD plus the per-instance ticket
 * cache shared across gateways. `hooks` carries cross-gateway concerns
 * (Project V2 board add).
 */

import { parseBlockedBy, parseBlocks } from '../../lib/dependency-parser.js';
import { Logger } from '../../lib/Logger.js';
import { addIssueToBoard } from './board-add.js';
import { createInlineTicketCache } from './cache.js';
import { withTransientRetry } from './errors.js';
import { issueToListItem, issueToTicket } from './mappers.js';
import {
  defaultRetryWarn,
  paginateRest,
  parseApiJson,
} from './request-helpers.js';

/**
 * Search API ceiling: 1000 results = 10 pages of 100. Hitting it means a
 * degenerate query, so stop rather than throw.
 */
const SEARCH_PAGE_CAP = 10;

export class TicketGateway {
  /**
   * @param {{
   *   gh: object,
   *   owner: string,
   *   repo: string,
   *   hooks?: {
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
    /**
     * Memo of `getTickets(epicId, filters)`; cleared on every write.
     * @type {Map<string, object[]>}
     */
    this._listCache = new Map();
  }

  /** Shared with sibling gateways so their mutations can invalidate it. */
  get cache() {
    return this._cache;
  }

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
   * Paginated manually: search responses are `{ total_count, items }`
   * envelopes, not the bare arrays `paginateRest` expects.
   */
  async _searchIssues(query) {
    const items = [];
    for (let page = 1; page <= SEARCH_PAGE_CAP; page++) {
      const params = new URLSearchParams({
        q: query,
        per_page: '100',
        page: String(page),
      });
      const result = await withTransientRetry(
        () =>
          this._gh.api({
            method: 'GET',
            endpoint: `/search/issues?${params}`,
          }),
        { label: `searchIssues page ${page}`, onRetry: defaultRetryWarn },
      );
      const parsed = parseApiJson(result);
      const batch = Array.isArray(parsed?.items) ? parsed.items : [];
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  /**
   * Two body searches (the `Epic:` and `parent:` footers) deduped by number.
   * Search tokenization over-matches (issue 10 hits issue 100), so callers
   * MUST keep the word-boundary regex post-filter.
   */
  async _searchEpicChildren(epicId, filters) {
    const qualifiers = [`repo:${this.owner}/${this.repo}`, 'is:issue'];
    const state = filters.state ?? 'all';
    if (state === 'open' || state === 'closed') {
      qualifiers.push(`state:${state}`);
    }
    if (filters.label) qualifiers.push(`label:"${filters.label}"`);
    const base = qualifiers.join(' ');

    const [epicRefs, parentRefs] = await Promise.all([
      this._searchIssues(`${base} "Epic: #${epicId}" in:body`),
      this._searchIssues(`${base} "parent: #${epicId}" in:body`),
    ]);

    const byNumber = new Map();
    for (const issue of [...epicRefs, ...parentRefs]) {
      if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
    }
    return Array.from(byNumber.values());
  }

  /** Repo-wide fallback for when the Search API fails. */
  /* node:coverage ignore next */
  async _listAllIssues(filters) {
    const params = new URLSearchParams({ state: filters.state ?? 'all' });
    if (filters.label) params.set('labels', filters.label);
    const endpoint = `/repos/${this.owner}/${this.repo}/issues?${params}`;
    return paginateRest(this._gh, endpoint);
  }

  /**
   * @field-manifest /search/issues?q=...: number, id, node_id, title,
   *                 body, labels, state, pull_request
   * @field-manifest /repos/{owner}/{repo}/issues?state=...&labels=...:
   *                 number, body, labels, state, pull_request
   */
  async getTickets(epicId, filters = {}) {
    const memoKey = `${epicId}|${filters.state ?? 'all'}|${filters.label ?? ''}`;
    if (this._listCache.has(memoKey)) return this._listCache.get(memoKey);

    let issues;
    try {
      issues = await this._searchEpicChildren(epicId, filters);
    } catch (err) {
      const msg = typeof err?.message === 'string' ? err.message : String(err);
      Logger.warn(
        `[TicketGateway] search-based getTickets(#${epicId}) failed (${msg}); ` +
          'falling back to repo-wide issue listing',
      );
      issues = await this._listAllIssues(filters);
    }

    // Word boundary: epic 1 must not match 10 or 100.
    const epicRefRe = new RegExp(
      `(?:Epic:\\s*#${epicId}|parent:\\s*#${epicId})(?:\\s|$|[,.)\\]])`,
    );

    const tickets = issues
      .filter((issue) => {
        if (issue.pull_request) return false;
        const body = issue.body ?? '';
        return epicRefRe.test(body);
      })
      .map(issueToListItem);
    this._listCache.set(memoKey, tickets);
    return tickets;
  }

  /* node:coverage ignore next */
  async getTicketDependencies(ticketId) {
    const ticket = await this.getTicket(ticketId);
    return {
      blocks: parseBlocks(ticket.body),
      blockedBy: parseBlockedBy(ticket.body),
    };
  }

  primeTicketCache(tickets) {
    this._cache.primeMany(tickets);
  }

  invalidateTicket(ticketId) {
    this._cache.invalidate(ticketId);
    this._listCache.clear();
  }

  /**
   * Create a bare issue (the only create path) and add it to the Project V2
   * board (non-fatal, no-op without a project). The POST retries transient
   * failures; because a lost response would double-create, `findExisting` is
   * consulted before every retry POST and a hit is adopted. Callers with no
   * content identity omit it and get retry-only behaviour.
   *
   * @field-manifest POST /repos/{owner}/{repo}/issues: number, id, node_id,
   *                 html_url
   *
   * @param {{
   *   title: string,
   *   body: string,
   *   labels?: string[],
   *   findExisting?: (() => Promise<object|null>)|null,
   * }} payload
   * @returns {Promise<{
   *   id: number,
   *   number: number,
   *   internalId: number,
   *   nodeId: string,
   *   url: string,
   *   adopted: boolean,
   *   boardAdd: { added: boolean, reason?: string },
   * }>}
   */
  async createIssue({ title, body, labels = [], findExisting = null }) {
    const { issue, adopted } = await this._createIssueOrAdopt({
      title,
      body,
      labels,
      findExisting,
    });
    this._listCache.clear();

    const boardAdd = await addIssueToBoard({
      nodeId: issue.node_id,
      issueNumber: issue.number,
      getProjectNumber: this._hooks.getProjectNumber,
      addItemToProject: this._hooks.addItemToProject,
    });

    return {
      id: issue.number,
      number: issue.number,
      internalId: issue.id,
      nodeId: issue.node_id,
      url: issue.html_url,
      adopted,
      boardAdd,
    };
  }

  /**
   * @param {{ title: string, body: string, labels: string[] }} payload
   * @returns {Promise<object>}
   */
  async _postIssue(payload) {
    return parseApiJson(
      await this._gh.api({
        method: 'POST',
        endpoint: `/repos/${this.owner}/${this.repo}/issues`,
        body: payload,
      }),
    );
  }

  /**
   * Did a prior attempt land? `ECONNRESET` looks the same before and after
   * the server commits, so only the server's state can say.
   *
   * @param {(() => Promise<object|null>)|null} findExisting
   * @returns {Promise<object|null>} the already-created issue, or `null`.
   */
  async _findAlreadyCreated(findExisting) {
    return typeof findExisting === 'function' ? await findExisting() : null;
  }

  /**
   * @param {{ title: string, body: string, labels: string[], findExisting: (() => Promise<object|null>)|null }} args
   * @returns {Promise<{ issue: object, adopted: boolean }>}
   */
  async _createIssueOrAdopt({ title, body, labels, findExisting }) {
    let posts = 0;
    return withTransientRetry(
      async () => {
        if (posts > 0) {
          const issue = await this._findAlreadyCreated(findExisting);
          if (issue) return { issue, adopted: true };
        }
        posts += 1;
        const issue = await this._postIssue({ title, body, labels });
        return { issue, adopted: false };
      },
      { label: `createIssue "${title}"`, onRetry: defaultRetryWarn },
    );
  }

  /**
   * Additive assignee write: cannot evict an assignee another run added
   * concurrently. Empty/absent list is a no-op.
   *
   * @param {number} ticketId
   * @param {string[]|undefined} logins
   */
  async _addAssignees(ticketId, logins) {
    if (!(logins?.length > 0)) return;
    await withTransientRetry(
      () =>
        this._gh.api({
          method: 'POST',
          endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}/assignees`,
          body: { assignees: logins },
        }),
      { label: `addAssignees #${ticketId}`, onRetry: defaultRetryWarn },
    );
    this.invalidateTicket(ticketId);
  }

  /**
   * Add-only with no other PATCH fields uses the atomic additive labels POST
   * (no read-before-write); otherwise returns the merged label set for the
   * caller's PATCH. Retried because parallel write fan-outs hit the secondary
   * rate limit; a genuine failure still throws.
   */
  async _applyLabelMutations(
    ticketId,
    labelMutations,
    hasOtherPatchFields,
    ticketSnapshot = null,
  ) {
    const { add = [], remove = [] } = labelMutations;

    if (add.length > 0 && remove.length === 0 && !hasOtherPatchFields) {
      await withTransientRetry(
        () =>
          this._gh.api({
            method: 'POST',
            endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}/labels`,
            body: { labels: add },
          }),
        { label: `addLabels #${ticketId}`, onRetry: defaultRetryWarn },
      );
      return { skipPatch: true };
    }

    // Reuse a caller-supplied snapshot rather than re-fetching.
    const ticket = ticketSnapshot ?? (await this.getTicket(ticketId));
    const currentLabels = new Set(ticket.labels ?? []);
    for (const l of remove) currentLabels.delete(l);
    for (const l of add) currentLabels.add(l);

    return { skipPatch: false, mergedLabels: Array.from(currentLabels) };
  }

  /**
   * `mutations.addAssignees` appends rather than replaces: the lease claim
   * needs a simultaneous claimer to show up as a co-assignment (what its
   * `lost-race` back-out keys on) instead of being silently evicted.
   * `mutations.assignees` replaces (steal/release paths).
   *
   * @field-manifest POST /repos/{owner}/{repo}/issues/{n}/assignees: assignees
   * @field-manifest PATCH /repos/{owner}/{repo}/issues/{n}:
   *                 body, assignees, state, state_reason, labels
   */
  /* node:coverage ignore next */
  async updateTicket(ticketId, mutations) {
    await this._addAssignees(ticketId, mutations.addAssignees);
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
      await withTransientRetry(
        () =>
          this._gh.api({
            method: 'PATCH',
            endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}`,
            body: patch,
          }),
        { label: `updateTicket #${ticketId}`, onRetry: defaultRetryWarn },
      );
      this.invalidateTicket(ticketId);
    }
  }
}
