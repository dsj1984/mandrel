/**
 * GitHub Provider — issue surface rebuilt on gh-exec (Story #1357, Epic #1179).
 *
 * Wave 1 of the v6 MCP+gh CLI rebase. This file is being migrated layer-by-
 * layer off the bespoke `providers/github/*` submodule tree onto the `gh` CLI
 * via the shim in `lib/gh-exec.js`. The submodule tree (`./github/auth.js`,
 * `./github/issues.js`, `./github/comments.js`, etc.) is intentionally still
 * on disk during this wave — Wave 3 (Story #1363) deletes it. What we change
 * here is which methods on `GitHubProvider` call into that old tree:
 *
 *   - Issue surface (Task #1368, this commit): `getTicket`, `getEpic`,
 *     `getEpics`, `getTickets`, `getSubTickets`, `getTicketDependencies`,
 *     `createTicket`, `updateTicket`, `addSubIssue`, `removeSubIssue`,
 *     `reconcileSubIssueLinks`, `listIssues`, `listIssuesByLabel` — now call
 *     `gh.api({ method, endpoint, body })` and parse stdout. Sub-issue link
 *     mutations stay on GraphQL via `gh api graphql` with a POST body
 *     carrying `{ query, variables }`.
 *
 *   - Comment surface (Task #1372, next commit): `getRecentComments`,
 *     `getTicketComments`, `postComment`, `deleteComment` — still delegate
 *     to `./github/comments.js`.
 *
 *   - Everything else (`createPullRequest`, `getBranchProtection`,
 *     `setBranchProtection`, `getMergeMethods`, `setMergeMethods`,
 *     `ensureLabels`, `resolveOrCreateProject`, `ensureStatusField`,
 *     `ensureProjectViews`, `ensureProjectFields`, `graphql`) still calls
 *     the old `./github/*` submodules. Subsequent Stories in this Epic rewrite
 *     those.
 *
 * Field manifests. `gh api /repos/.../issues/N` returns the full REST Issue
 * JSON shape, so the existing `ticket-mapper.js` pure helpers still apply
 * unchanged. We capture which fields each consumer expects as inline
 * constants next to the method that uses them, per the Tech Spec field-
 * manifest convention.
 *
 * @see docs/v5-implementation-plan.md (legacy reference — superseded by
 *      Epic #1179 Tech Spec #1350).
 */

import { parseBlockedBy, parseBlocks } from '../lib/dependency-parser.js';
import { gh as defaultGh } from '../lib/gh-exec.js';
import { ITicketingProvider } from '../lib/ITicketingProvider.js';
import { Logger } from '../lib/Logger.js';
import { TYPE_LABELS } from '../lib/label-constants.js';
import { composeTaskBody } from '../lib/templates/task-body-renderer.js';
import { concurrentMap } from '../lib/util/concurrent-map.js';
import { resolveToken } from './github/auth.js';
import * as branches from './github/branches.js';
import { createTicketCacheManager } from './github/cache-manager.js';
import * as comments from './github/comments.js';
import { classifyGithubError } from './github/error-classifier.js';
import {
  ADD_SUB_ISSUE_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  SUB_ISSUES_QUERY,
} from './github/graphql-builder.js';
import { GithubHttpClient } from './github/http.js';
import * as labels from './github/labels.js';
import * as projects from './github/projects.js';
import * as repo from './github/repo.js';
import {
  issueToEpic,
  issueToEpicListItem,
  issueToListItem,
  issueToTicket,
  subIssueNodeToTicket,
} from './github/ticket-mapper.js';

export { __setExecSyncForTests } from './github/auth.js';

// ---------------------------------------------------------------------------
// Concurrency + retry budgets — preserved from the old `./github/issues.js`
// so dispatch fan-out and sub-issue reconciliation keep the same shape.
// ---------------------------------------------------------------------------
const SUBTICKET_HYDRATION_CONCURRENCY = 8;
const SUB_ISSUE_RECONCILE_CONCURRENCY = 4;
const SUB_ISSUE_RETRY_MAX_ATTEMPTS = 6;
const SUB_ISSUE_RETRY_BASE_DELAY_MS = 1000;
const SUB_ISSUE_RETRY_MAX_DELAY_MS = 30000;
const SUB_ISSUE_RETRY_JITTER_MS = 500;

/**
 * Parse a `gh api ...` stdout payload into JSON. `gh-exec.exec` returns
 * `{ stdout, stderr, code }` for `gh api` calls (no `--json` flag is set on
 * the inner argv), so we own the parse here. Returns `null` for empty
 * bodies (HTTP 204 DELETE responses).
 */
function parseApiJson(result) {
  const stdout = result?.stdout ?? '';
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

/**
 * Paginate a REST list endpoint by appending `page=N&per_page=100` until a
 * short page lands. Mirrors `GithubHttpClient.restPaginated` so consumers
 * (`listIssuesByLabel`, `getEpics`, `getTickets`, `getTicketComments`) see
 * the same all-pages array they did under the bespoke client. We deliberately
 * sidestep `gh api --paginate` here because that flag emits concatenated
 * JSON documents (one per page) rather than a single array, which would
 * require either `--slurp` (gh 2.40+) or jq post-processing — both of which
 * push complexity into argv-space the test seam doesn't see.
 *
 * @param {object} ghFacade  the bound gh facade (this._gh).
 * @param {string} endpoint  REST endpoint without `page=` set.
 */
async function paginateRest(ghFacade, endpoint) {
  const items = [];
  const separator = endpoint.includes('?') ? '&' : '?';
  let page = 1;
  while (true) {
    const result = await ghFacade.api({
      method: 'GET',
      endpoint: `${endpoint}${separator}page=${page}&per_page=100`,
    });
    const batch = parseApiJson(result);
    if (!Array.isArray(batch)) break;
    items.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return items;
}

export class GitHubProvider extends ITicketingProvider {
  /**
   * @param {{ owner: string, repo: string, projectNumber?: number|null, projectOwner?: string, projectName?: string|null, operatorHandle?: string }} config
   * @param {{ token?: string, http?: GithubHttpClient, fetchImpl?: typeof fetch, gh?: object }} [opts]
   *   `gh` — optional gh-exec facade override (test seam). Production callers
   *   leave this unset; the module-level `defaultGh` singleton from
   *   `lib/gh-exec.js` shells out to the real `gh` CLI. Tests inject
   *   `createGh(fakeExec)` so they never spawn a real subprocess.
   */
  constructor(config, opts = {}) {
    super();
    this.owner = config.owner;
    this.repo = config.repo;
    this.projectNumber = config.projectNumber ?? null;
    this.projectOwner = config.projectOwner ?? config.owner;
    this.projectName = config.projectName ?? null;
    this.operatorHandle = config.operatorHandle ?? null;

    // Old transport — retained for the still-bespoke methods (branches,
    // projects, labels, repo, raw `graphql`). The issue/comment paths no
    // longer touch this; Wave 3 deletes the field altogether.
    this._http =
      opts.http ??
      new GithubHttpClient({
        tokenProvider: () => opts.token ?? resolveToken(),
        fetchImpl: opts.fetchImpl,
      });

    // New transport — gh-exec facade. Issue + comment methods route through
    // this. Defaults to the module-level singleton bound to the real
    // `child_process.spawn`; tests override via `opts.gh`.
    this._gh = opts.gh ?? defaultGh;

    // Per-instance ticket cache shared by dispatcher / reconciler / cascade.
    // Mutations (`updateTicket` / `postComment`) invalidate; list endpoints
    // (`getTickets`, `getSubTickets`) deliberately do NOT populate it.
    this._cache = createTicketCacheManager();

    // ctx is the shared object every still-bespoke submodule reads from.
    // `projectNumber` gets a live getter/setter so `resolveOrCreateProject`
    // can mutate it on demand; `http` / `cache` are live getters so tests
    // that reassign `provider._http` / `provider._cache` see the new
    // instance. Issue/comment methods do NOT read from `ctx` anymore.
    const provider = this;
    this._ctx = {
      owner: this.owner,
      repo: this.repo,
      projectOwner: this.projectOwner,
      projectName: this.projectName,
      operatorHandle: this.operatorHandle,
      get projectNumber() {
        return provider.projectNumber;
      },
      set projectNumber(v) {
        provider.projectNumber = v;
      },
      get http() {
        return provider._http;
      },
      get cache() {
        return provider._cache;
      },
      state: { projectId: null },
      hooks: {
        // Branches submodule still calls `getTicket` via this hook when
        // creating a PR. Route it through the new gh-exec path so the
        // cache stays coherent.
        getTicket: (id, o) => provider.getTicket(id, o),
        addItemToProject: (nodeId) =>
          projects.addItemToProject(this._ctx, nodeId),
      },
    };
  }

  get token() {
    return this._http.token;
  }

  // -------------------------------------------------------------------------
  // Raw GraphQL — still on the bespoke client for now. Sub-issue mutations
  // below shell out via `gh api graphql` so this method is only used by the
  // Projects V2 surface (subsequent story scope).
  // -------------------------------------------------------------------------
  async graphql(query, variables = {}, opts = {}) {
    return this._http.graphql(query, variables, opts);
  }

  // =========================================================================
  // ISSUE SURFACE — rewritten on gh-exec (Task #1368)
  // =========================================================================

  /**
   * Run a GraphQL query/mutation through `gh api graphql` (POST with a JSON
   * `{ query, variables }` body on stdin). Returns the `data` field. Throws
   * when the response contains a non-empty `errors[]`.
   *
   * @param {string} query
   * @param {Record<string, unknown>} [variables]
   * @param {{ headers?: Record<string, string> }} [_opts]
   *   Reserved for forward compatibility (e.g. `GraphQL-Features` feature
   *   flags). `gh api` does not currently surface a per-call header flag in
   *   our wrapper; the underlying `gh` CLI already sends the right
   *   `Accept`/`Content-Type` for GraphQL, and feature-preview headers are
   *   handled by `gh`'s built-in flag set.
   *
   * @returns {Promise<object>} the `data` field from the GraphQL response.
   */
  async _ghGraphql(query, variables = {}, _opts = {}) {
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

  /* node:coverage ignore next */
  async listIssues(filters = {}) {
    return this.getEpics(filters);
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
    const result = await this._gh.api({
      method: 'GET',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/${epicId}`,
    });
    return issueToEpic(parseApiJson(result));
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

  /**
   * Strategy 1 — native GitHub Sub-Issues via GraphQL. Paginates and seeds
   * the ticket cache. Returns `[]` (not throw) when the feature is disabled
   * on this repo.
   */
  async _getNativeSubIssues(parentNodeId, parentId) {
    const childIds = [];
    let cursor = null;
    try {
      while (true) {
        const data = await this._ghGraphql(
          SUB_ISSUES_QUERY,
          { id: parentNodeId, cursor },
          { headers: { 'GraphQL-Features': 'sub_issues' } },
        );
        const page = data.node?.subIssues;
        const nodes = page?.nodes ?? [];
        for (const node of nodes) {
          childIds.push(node.number);
          this._cache.primeIfAbsent(subIssueNodeToTicket(node));
        }
        if (!page?.pageInfo?.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
    } catch (err) {
      const category = classifyGithubError(err);
      if (category === 'feature-disabled') {
        Logger.warn(
          `[GitHubProvider] sub-issues GraphQL unavailable (parent #${parentId}); using checklist fallback`,
        );
        return [];
      }
      Logger.error(
        `[GitHubProvider] sub-issues GraphQL failed (parent #${parentId}, category=${category}): ${err.message}`,
      );
      throw err;
    }
    return childIds;
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
    try {
      const issues = await this.getTickets(parentId);
      this.primeTicketCache(issues);
      return issues.map((i) => i.id);
    } catch (err) {
      Logger.warn(
        `[GitHubProvider] reverse dependency lookup (parent #${parentId}): ${err.message}`,
      );
      return [];
    }
  }

  async getSubTickets(parentId) {
    const parent = await this.getTicket(parentId);
    const [nativeChildIds, checklistChildIds, referencedChildIds] =
      await Promise.all([
        this._getNativeSubIssues(parent.nodeId, parentId),
        Promise.resolve(this._getChecklistChildren(parent.body)),
        this._getReferencedChildren(parentId),
      ]);

    // Dedupe while preserving the historical fallback order.
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
        this.getTicket(id).catch((err) => {
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
    const result = await this._gh.api({
      method: 'GET',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}`,
    });
    const ticket = issueToTicket(parseApiJson(result));
    this._cache.set(ticketId, ticket);
    return ticket;
  }

  primeTicketCache(tickets) {
    this._cache.primeMany(tickets);
  }

  invalidateTicket(ticketId) {
    this._cache.invalidate(ticketId);
  }

  /* node:coverage ignore next */
  async getTicketDependencies(ticketId) {
    const ticket = await this.getTicket(ticketId);
    return {
      blocks: parseBlocks(ticket.body),
      blockedBy: parseBlockedBy(ticket.body),
    };
  }

  /**
   * Create a new issue. Renders the body via `composeTaskBody` so the
   * `parent: #N` / `Epic: #M` footer is consistent across creators.
   *
   * After the POST, opportunistically link the child as a native sub-issue
   * (retried on transient errors) and add it to the configured Project V2
   * (best-effort — failures warn but do not fail the create).
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
      await this.addSubIssue(parentId, issue.node_id);
      subIssueLinked = true;
    } catch (err) {
      subIssueError = err;
    }

    try {
      if (this.projectNumber) {
        await this._ctx.hooks.addItemToProject(issue.node_id);
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
   * Establish the native sub-issue link between `parentNumber` and the child
   * identified by `childNodeId`. Retries on transient errors with jittered
   * exponential backoff before re-throwing.
   */
  async addSubIssue(
    parentNumber,
    childNodeId,
    opts = { replaceParent: false },
  ) {
    const parentTicket = await this.getTicket(parentNumber);
    let lastErr;
    for (let attempt = 0; attempt < SUB_ISSUE_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._ghGraphql(
          ADD_SUB_ISSUE_MUTATION,
          {
            parentId: parentTicket.nodeId,
            subIssueId: childNodeId,
            replaceParent: opts.replaceParent,
          },
          { headers: { 'GraphQL-Features': 'sub_issues' } },
        );
      } catch (err) {
        lastErr = err;
        const category = classifyGithubError(err);
        const isFinalAttempt = attempt === SUB_ISSUE_RETRY_MAX_ATTEMPTS - 1;
        if (category !== 'transient' || isFinalAttempt) throw err;
        const base = Math.min(
          SUB_ISSUE_RETRY_MAX_DELAY_MS,
          SUB_ISSUE_RETRY_BASE_DELAY_MS * 2 ** attempt,
        );
        const delay =
          base + Math.floor(Math.random() * SUB_ISSUE_RETRY_JITTER_MS);
        Logger.warn(
          `[GitHubProvider] sub-issue link transient error for parent #${parentNumber} (attempt ${attempt + 1}/${SUB_ISSUE_RETRY_MAX_ATTEMPTS}); retrying in ${delay}ms: ${err.message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  async removeSubIssue(parentNumber, subIssueNumber) {
    const parentTicket = await this.getTicket(parentNumber);
    const childTicket = await this.getTicket(subIssueNumber);
    return this._ghGraphql(
      REMOVE_SUB_ISSUE_MUTATION,
      { parentId: parentTicket.nodeId, subIssueId: childTicket.nodeId },
      { headers: { 'GraphQL-Features': 'sub_issues' } },
    );
  }

  /**
   * Walk every child of `epicId` whose body footer carries `parent: #N` and
   * verify the native sub-issue link is present. Re-establish missing links
   * via `addSubIssue` (which retries internally). Idempotent.
   */
  async reconcileSubIssueLinks(epicId) {
    const PARENT_RE = /(?:^|\n)parent:\s*#(\d+)/;
    const allChildren = await this.getTickets(epicId);
    const parentByChild = new Map();
    for (const child of allChildren) {
      const match = (child.body ?? '').match(PARENT_RE);
      if (!match) continue;
      parentByChild.set(child.id, Number.parseInt(match[1], 10));
    }

    const childrenByParent = new Map();
    for (const [childId, parentId] of parentByChild) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(childId);
    }

    let alreadyLinked = 0;
    let reconciled = 0;
    let failed = 0;
    const failures = [];

    const parentEntries = Array.from(childrenByParent.entries());

    await concurrentMap(
      parentEntries,
      async ([parentId, childIds]) => {
        let parent;
        try {
          parent = await this.getTicket(parentId);
        } catch (err) {
          for (const childId of childIds) {
            failures.push({ parentId, childId, reason: err.message });
          }
          failed += childIds.length;
          return;
        }
        if (!parent?.nodeId) {
          for (const childId of childIds) {
            failures.push({
              parentId,
              childId,
              reason: 'parent missing nodeId',
            });
          }
          failed += childIds.length;
          return;
        }

        const linked = new Set(
          await this._getNativeSubIssues(parent.nodeId, parentId),
        );

        await concurrentMap(
          childIds,
          async (childId) => {
            if (linked.has(childId)) {
              alreadyLinked++;
              return;
            }
            let childTicket;
            try {
              childTicket = await this.getTicket(childId);
            } catch (err) {
              failures.push({ parentId, childId, reason: err.message });
              failed++;
              return;
            }
            if (!childTicket?.nodeId) {
              failures.push({
                parentId,
                childId,
                reason: 'child missing nodeId',
              });
              failed++;
              return;
            }
            try {
              await this.addSubIssue(parentId, childTicket.nodeId);
              reconciled++;
            } catch (err) {
              failures.push({ parentId, childId, reason: err.message });
              failed++;
            }
          },
          { concurrency: SUB_ISSUE_RECONCILE_CONCURRENCY },
        );
      },
      { concurrency: SUB_ISSUE_RECONCILE_CONCURRENCY },
    );

    return {
      totalExpected: parentByChild.size,
      alreadyLinked,
      reconciled,
      failed,
      failures,
    };
  }

  /**
   * Add/remove labels on an issue. When the only mutation is "add", uses the
   * additive labels endpoint (POST /issues/{n}/labels) for atomicity and to
   * avoid a read-before-write. When other PATCH fields are present, or when
   * removing labels, computes the final label set and returns it to the
   * caller for inclusion in the PATCH.
   *
   * Exposed via `_updateLabels` because existing unit tests assert on it
   * directly.
   */
  async _applyLabelMutations(ticketId, labelMutations, hasOtherPatchFields) {
    const { add = [], remove = [] } = labelMutations;

    if (add.length > 0 && remove.length === 0 && !hasOtherPatchFields) {
      await this._gh.api({
        method: 'POST',
        endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}/labels`,
        body: { labels: add },
      });
      return { skipPatch: true };
    }

    const ticket = await this.getTicket(ticketId);
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

  // =========================================================================
  // COMMENT SURFACE — still on the bespoke submodule (delete in Task #1372).
  // =========================================================================

  async getRecentComments(limit = 100) {
    return comments.getRecentComments(this._ctx, limit);
  }

  async getTicketComments(ticketId) {
    return comments.getTicketComments(this._ctx, ticketId);
  }

  async deleteComment(commentId) {
    return comments.deleteComment(this._ctx, commentId);
  }

  async postComment(ticketId, payload) {
    const normalized =
      typeof payload === 'string' ? { body: payload } : payload;
    return comments.postComment(this._ctx, ticketId, normalized);
  }

  // =========================================================================
  // PR / BRANCH / LABEL / PROJECT / REPO SURFACE
  //
  // Still delegated to the old `./github/*` submodules until subsequent
  // Stories in Epic #1179 rewrite them. The submodules read from `this._ctx`,
  // which exposes `this._http` (the bespoke transport). Issue/comment
  // method calls below this line do NOT touch `_http`.
  // =========================================================================

  /* node:coverage ignore next */
  async createPullRequest(branchName, ticketId, baseBranch = 'main') {
    return branches.createPullRequest(
      this._ctx,
      branchName,
      ticketId,
      baseBranch,
    );
  }

  async getBranchProtection(branch) {
    return branches.getBranchProtection(this._ctx, branch);
  }

  async setBranchProtection(branch, opts) {
    return branches.setBranchProtection(this._ctx, branch, opts);
  }

  async getMergeMethods() {
    return repo.getMergeMethods(this._ctx);
  }

  async setMergeMethods(settings) {
    return repo.setMergeMethods(this._ctx, settings);
  }

  async ensureLabels(labelDefs) {
    return labels.ensureLabels(this._ctx, labelDefs);
  }

  static isInsufficientScopes(err) {
    return projects.isInsufficientScopes(err);
  }

  async resolveOrCreateProject(opts = {}) {
    return projects.resolveOrCreateProject(this._ctx, opts);
  }

  async ensureStatusField(optionNames) {
    return projects.ensureStatusField(this._ctx, optionNames);
  }

  async ensureProjectViews(viewDefs) {
    return projects.ensureProjectViews(this._ctx, viewDefs);
  }

  /* node:coverage ignore next */
  async ensureProjectFields(fieldDefs) {
    return projects.ensureProjectFields(this._ctx, fieldDefs);
  }

  // Underscore-prefixed wrapper preserves the surface that
  // `tests/lib/github-provider.test.js` reaches for. Not part of the public
  // ITicketingProvider.
  _updateLabels(ticketId, labelMutations, hasOtherPatchFields) {
    return this._applyLabelMutations(
      ticketId,
      labelMutations,
      hasOtherPatchFields,
    );
  }
}
