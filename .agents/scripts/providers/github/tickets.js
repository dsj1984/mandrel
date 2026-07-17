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
 * signature. The `addItemToProject` hook (from the projects-v2 shim) adds a
 * newly-created issue to the configured Project V2.
 *
 * Story #4545 deleted `createTicket` and its `composeStoryBody` helper — the
 * Epic-hierarchy write surface. It composed the exact `Epic: #N` footer that
 * `pr-base-guard.js` hard-refuses at delivery, so the framework retained the
 * ability to generate work it would then reject; it had no production caller
 * (`/plan` persists through the bare `createIssue` below).
 *
 * Public surface: `GitHubProvider.createIssue / getTicket /
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
     * Per-instance memo of `getTickets(epicId, filters)` results (Story
     * #3988). Planning-era healing fetched the same child list twice
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
   * Create a **bare** issue — no footer composition and no sub-issue link.
   * Since Story #4545 this is the *only* create path: `/plan` persist and the
   * `/plan` Phase 4 Epic open (`openEpicFromOnePager`'s `createIssue` port)
   * both route through it.
   *
   * After the POST, the new issue is added to the configured Project V2
   * board via the shared `addIssueToBoard` helper (Story #3822) —
   * idempotent, non-fatal, and a no-op when no project number resolves —
   * so board membership never depends on GitHub's "Auto-add to project"
   * built-in workflow.
   *
   * The POST is wrapped in `withTransientRetry` (Story #4541) so it absorbs
   * the same 502/429/ECONNRESET blips the read surfaces already do. It used
   * to post bare, which made a single transient failure at story *k* of *N*
   * abort `/plan` persist with `1..k-1` already live on the tracker.
   *
   * Retry alone is not sufficient for that failure mode — a POST whose
   * response is lost would double-create on the retry — so the caller
   * (`plan-persist`'s `createStoryIssues`) carries the idempotency half via
   * a plan fingerprint it looks up before creating. Retry narrows the
   * window; the fingerprint closes it.
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
    const result = await withTransientRetry(
      () =>
        this._gh.api({
          method: 'POST',
          endpoint: `/repos/${this.owner}/${this.repo}/issues`,
          body: { title, body, labels },
        }),
      { label: `createIssue "${title}"`, onRetry: defaultRetryWarn },
    );
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
