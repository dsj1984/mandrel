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
 * Public surface: `GitHubProvider.createTicket / createIssue / getTicket /
 * getTickets / updateTicket / getTicketDependencies / primeTicketCache /
 * invalidateTicket` all delegate to the same-named methods on this class.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
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
 * GitHub Search API hard ceiling is 1000 results per query; at
 * `per_page=100` that is 10 pages. An Epic never has anywhere near 1000
 * children, so hitting this cap means the query is degenerate — we stop
 * rather than throw (the regex post-filter keeps results correct).
 */
const SEARCH_PAGE_CAP = 10;

/**
 * Compose the final markdown body for a created ticket. Under the 2-tier
 * hierarchy (Epic → Story), `body` is always a string supplied
 * by the caller (the decomposer, the spec planner, or the reconciler-apply
 * engine). This helper appends the canonical orchestrator footer
 * (`parent: #<n>` / `Epic: #<m>` / `blocked by #<x>`) byte-stable with the
 * format consumers (manifest, close-gate, dispatcher) parse.
 *
 * Story #3186 — inlined here when the Task-tier body-renderer helpers
 * were retired. The structured-body (object) path is gone: Stories carry
 * inline `acceptance[]` / `verify[]`
 * arrays on the Story body authored by the decomposer; there is no
 * server-side rendering of a four-section payload at create time.
 *
 * @param {{
 *   body: string,
 *   parentId: number,
 *   epicId?: number,
 *   dependencies?: number[],
 * }} opts
 * @returns {string}
 *
 * Story #3958 — this is the single owner of the `blocked by #N` footer.
 * Callers (the reconciler-apply create path, the spec planner) pass
 * resolved dependency issue numbers via `dependencies` and supply a body
 * WITHOUT any pre-appended footer. A caller that also appends a
 * `blocked by` block to `body` would double every dependency line.
 */
export function composeStoryBody({
  body,
  parentId,
  epicId,
  dependencies = [],
}) {
  const head = typeof body === 'string' ? body : '';
  const lines = ['---', `parent: #${parentId}`];
  if (epicId !== undefined && epicId !== null) {
    lines.push(`Epic: #${epicId}`);
  }
  if (dependencies.length > 0) {
    lines.push('');
    for (const dep of dependencies) {
      lines.push(`blocked by #${dep}`);
    }
  }
  return `${head}\n\n${lines.join('\n')}`;
}

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
    /**
     * Per-instance memo of `getTickets(epicId, filters)` results (Story
     * #3988). The planning-state-manager fetches the same child list twice
     * per planning pass; without this memo each fetch re-pays the full
     * search/list round-trip. Invalidated on every write surface.
     * @type {Map<string, object[]>}
     */
    this._listCache = new Map();
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
   * Run one Search API query (`/search/issues`) to completion, returning
   * the raw issue items. Search responses are `{ total_count, items }`
   * envelopes rather than bare arrays, so this paginates manually instead
   * of going through `paginateRest`.
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
   * Server-side narrowed child lookup (Story #3988): two Search API
   * queries — `"Epic: #N" in:body` and `"parent: #N" in:body` — deduped
   * by issue number. Replaces the repo-wide `state=all` pagination that
   * cost ~1 spawn per 100 repo issues and hard-failed past the
   * `paginateRest` page cap. Search tokenization can over-match (e.g.
   * `#10` vs `#100`), so callers MUST keep the word-boundary regex
   * post-filter.
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

  /**
   * Repo-wide listing fallback — the pre-#3988 shape. Only used when the
   * Search API path fails (search outage, search-specific rate limit).
   */
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

    // Word-boundary regex prevents #1 matching #10, #100, etc.
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

  // ---------------------------------------------------------------------------
  // Cache primers — exposed so the parent provider keeps a stable surface for
  // `primeTicketCache` / `invalidateTicket` callers.
  // ---------------------------------------------------------------------------

  primeTicketCache(tickets) {
    this._cache.primeMany(tickets);
  }

  invalidateTicket(ticketId) {
    this._cache.invalidate(ticketId);
    this._listCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Write surface
  // ---------------------------------------------------------------------------

  /**
   * Create a new issue. Renders the body via the inline `composeStoryBody`
   * helper so the `parent: #N` / `Epic: #M` / `blocked by #X` footer is
   * consistent across creators.
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
    const renderedBody = composeStoryBody({
      body: ticketData.body ?? '',
      parentId,
      epicId,
      dependencies: ticketData.dependencies ?? [],
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
    this._listCache.clear();

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

    await addIssueToBoard({
      nodeId: issue.node_id,
      issueNumber: issue.number,
      getProjectNumber: this._hooks.getProjectNumber,
      addItemToProject: this._hooks.addItemToProject,
    });

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
   * Create a **bare** issue — no `parent: #N` footer composition and no
   * sub-issue link. Serves the standalone create paths that bypass
   * `createTicket`'s Story-shaped body rendering: the `/plan`
   * persist step and the `/plan` Phase 4 Epic open
   * (`openEpicFromOnePager`'s `createIssue` port).
   *
   * After the POST, the new issue is added to the configured Project V2
   * board via the shared `addIssueToBoard` helper (Story #3822) —
   * idempotent, non-fatal, and a no-op when no project number resolves —
   * so board membership never depends on GitHub's "Auto-add to project"
   * built-in workflow.
   *
   * @field-manifest POST /repos/{owner}/{repo}/issues: number, id, node_id,
   *                 html_url
   *
   * @param {{ title: string, body: string, labels?: string[] }} payload
   * @returns {Promise<{
   *   id: number,
   *   number: number,
   *   internalId: number,
   *   nodeId: string,
   *   url: string,
   *   boardAdd: { added: boolean, reason?: string },
   * }>}
   */
  async createIssue({ title, body, labels = [] }) {
    const result = await this._gh.api({
      method: 'POST',
      endpoint: `/repos/${this.owner}/${this.repo}/issues`,
      body: { title, body, labels },
    });
    const issue = parseApiJson(result);
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
      boardAdd,
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
