/**
 * GitHub Provider — composition root.
 *
 * Story #1846 split the four cross-cutting concerns out of this file into
 * the `./github/` sub-package. This module now does three things:
 *
 *   1. **Imports + re-exports** the public surface so external callers
 *      (tests, downstream code) keep resolving every symbol through the
 *      canonical `providers/github.js` import path. The named symbols
 *      live in their dedicated sub-modules:
 *
 *        - `./github/auth.js`     — `resolveToken`, `__setExecSyncForTests`,
 *                                   `execSyncHolder`, `readGhCliToken`
 *        - `./github/cache.js`    — `createInlineTicketCache`
 *        - `./github/errors.js`   — `classifyGithubError`, `extractErrorFields`,
 *                                   `isTransientStatus`, `isTransientByCodeOrMessage`,
 *                                   `isPermissionSignal`, `SUB_ISSUES_QUERY`,
 *                                   `ADD_SUB_ISSUE_MUTATION`,
 *                                   `REMOVE_SUB_ISSUE_MUTATION`
 *        - `./github/mappers.js`  — `issueToTicket`, `issueToEpic`,
 *                                   `issueToListItem`, `issueToEpicListItem`,
 *                                   `subIssueNodeToTicket`
 *        - `./github/projects-v2-graphql.js` — Projects V2 helpers
 *
 *   2. **Owns the gh-exec call surface** — the `GitHubProvider` class
 *      itself. Every transport method (issues, comments, branch-protection,
 *      PRs, labels, merge-methods) routes through the `gh` facade and uses
 *      the imported helpers to classify errors, parse payloads, and prime
 *      the per-instance cache.
 *
 *   3. **Holds the small file-local helpers** that bind the gh-exec call
 *      surface together — `parseApiJson`, `isNotFoundError`,
 *      `isLabelAlreadyExistsError`, `paginateRest`, and the retry/concurrency
 *      budget constants. These are private to the class and not part of the
 *      public surface.
 *
 * `graphql(query, variables, opts)` routes through `_ghGraphql`
 * (`gh api graphql`) so callers like `epic-reconcile.js` keep their public
 * surface unchanged.
 *
 * @see docs/v5-implementation-plan.md (legacy reference — superseded by
 *      Epic #1179 Tech Spec #1350).
 */

import { gh as defaultGh } from '../lib/gh-exec.js';
import { ITicketingProvider } from '../lib/ITicketingProvider.js';
import { Logger } from '../lib/Logger.js';
import { TYPE_LABELS } from '../lib/label-constants.js';
import { concurrentMap } from '../lib/util/concurrent-map.js';
import {
  __setExecSyncForTests,
  execSyncHolder,
  readGhCliToken,
  resolveToken,
} from './github/auth.js';
import {
  BranchProtectionGateway,
  isNotFoundError,
} from './github/branch-protection.js';
import { createInlineTicketCache } from './github/cache.js';
import { CommentGateway } from './github/comments.js';
import {
  ADD_SUB_ISSUE_MUTATION,
  classifyGithubError,
  extractErrorFields,
  isPermissionSignal,
  isTransientByCodeOrMessage,
  isTransientStatus,
  REMOVE_SUB_ISSUE_MUTATION,
  SUB_ISSUES_QUERY,
} from './github/errors.js';
import { LabelGateway } from './github/labels.js';
import {
  issueToEpic,
  issueToEpicListItem,
  issueToListItem,
  issueToTicket,
  subIssueNodeToTicket,
} from './github/mappers.js';
import * as projects from './github/projects-v2-graphql.js';
import { SubIssueGateway } from './github/sub-issues.js';
import { TicketGateway } from './github/tickets.js';

// ---------------------------------------------------------------------------
// Re-exports of extracted modules (Story #1846).
//
// Public surface preserved so external callers (tests, downstream code)
// keep resolving the same symbols through `./providers/github.js`:
//   - auth.js     → token resolution
//   - cache.js    → createInlineTicketCache
//   - errors.js   → classifyGithubError + GraphQL constants
//   - mappers.js  → pure REST/GraphQL ticket mappers
// ---------------------------------------------------------------------------
export {
  __setExecSyncForTests,
  ADD_SUB_ISSUE_MUTATION,
  classifyGithubError,
  createInlineTicketCache,
  execSyncHolder,
  extractErrorFields,
  isPermissionSignal,
  issueToEpic,
  issueToEpicListItem,
  issueToListItem,
  issueToTicket,
  isTransientByCodeOrMessage,
  isTransientStatus,
  REMOVE_SUB_ISSUE_MUTATION,
  readGhCliToken,
  SUB_ISSUES_QUERY,
  subIssueNodeToTicket,
};

// ---------------------------------------------------------------------------
// Concurrency budget for the `getSubTickets` fan-out — preserved from the
// old `./github/issues.js`. Per-strategy sub-issue retry/concurrency budgets
// live on the SubIssueGateway now (Story #2462 / Task #2480).
// ---------------------------------------------------------------------------
const SUBTICKET_HYDRATION_CONCURRENCY = 8;

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
 * Fields the merge-method bootstrap reads/writes. Held in a constant so
 * `getMergeMethods` and `setMergeMethods` cannot drift on which keys they
 * mirror. Anything the upstream API exposes outside this list is
 * deliberately ignored — operators may have tuned other repo flags and
 * we do not want to surface them through this narrow interface.
 */
const MERGE_METHOD_FIELDS = [
  'allow_squash_merge',
  'allow_rebase_merge',
  'allow_merge_commit',
  'allow_auto_merge',
  'delete_branch_on_merge',
];

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
   * @param {{ token?: string, gh?: object }} [opts]
   *   `token` — optional explicit token (used by `provider.token` getter and
   *   tests). Production resolves via `resolveToken()` lazily on first read.
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

    // Token is resolved lazily on first read of `this.token`. We honour an
    // explicit `opts.token` (test seam) over the env/CLI lookup. After
    // Wave 3 the only consumer of `provider.token` is the construction
    // smoke test in `tests/providers-github.test.js`; every transport call
    // routes through `gh-exec`, which owns its own auth via the `gh` CLI.
    this._explicitToken = opts.token ?? null;
    /** @type {string|null} memoized resolved token */
    this._memoizedToken = opts.token ?? null;

    // Transport — gh-exec facade. Every surface method routes through this.
    // Defaults to the module-level singleton bound to the real
    // `child_process.spawn`; tests override via `opts.gh`.
    this._gh = opts.gh ?? defaultGh;

    // Per-instance ticket cache shared by dispatcher / reconciler / cascade.
    // See `createInlineTicketCache` above. Mutations (`updateTicket` /
    // `postComment` / `addSubIssue` / `removeSubIssue`) invalidate; list
    // endpoints (`getTickets`, `getSubTickets`) deliberately do NOT populate
    // it (only individual `getTicket` reads and `primeIfAbsent` writes do).
    this._cache = createInlineTicketCache();

    // TicketGateway owns ticket CRUD against `/repos/{owner}/{repo}/issues`
    // plus the per-instance cache. The provider keeps the cache reference
    // for backwards compatibility (tests assert on `provider._cache`); the
    // gateway is the canonical writer.
    const provider = this;
    this.tickets = new TicketGateway({
      gh: this._gh,
      owner: this.owner,
      repo: this.repo,
      cache: this._cache,
      hooks: {
        addSubIssue: (parentNumber, childNodeId) =>
          provider.addSubIssue(parentNumber, childNodeId),
        addItemToProject: (nodeId) =>
          projects.addItemToProject(provider._ctx, nodeId),
        getProjectNumber: () => provider.projectNumber,
      },
    });

    // SubIssueGateway owns the native sub-issue GraphQL surface plus the
    // reconciler that walks `parent: #N` footers. It threads the parent's
    // `_ghGraphql` shim and the shared cache so native-walk priming hits
    // the same Map every other reader observes.
    this.subIssues = new SubIssueGateway({
      ghGraphql: (query, variables, opts) =>
        provider._ghGraphql(query, variables, opts),
      cache: this._cache,
      classifyGithubError,
      hooks: {
        getTicket: (id, opts) => provider.getTicket(id, opts),
        getTickets: (parentId) => provider.getTickets(parentId),
        primeTicketCache: (tickets) => provider.primeTicketCache(tickets),
        invalidateTicket: (id) => provider.invalidateTicket(id),
      },
    });

    // CommentGateway owns issue-comment CRUD. The structured-comment
    // marker prepended by `lib/orchestration/ticketing.js` arrives on the
    // payload body unchanged.
    this.comments = new CommentGateway({
      gh: this._gh,
      owner: this.owner,
      repo: this.repo,
      hooks: {
        invalidateTicket: (id) => provider.invalidateTicket(id),
      },
    });

    // LabelGateway owns `ensureLabels` + the live-set reconciliation
    // helpers. BranchProtectionGateway owns the protection PUT/GET
    // surface and the 404-aware getter. Both are pure gh-exec consumers
    // — no inter-gateway hooks required.
    this.labels = new LabelGateway({
      gh: this._gh,
      owner: this.owner,
      repo: this.repo,
    });
    this.branchProtection = new BranchProtectionGateway({
      gh: this._gh,
      owner: this.owner,
      repo: this.repo,
    });

    // ctx is the shared object the projects-v2-graphql shim reads from.
    // `projectNumber` gets a live getter/setter so `resolveOrCreateProject`
    // can mutate it on demand; `cache` is a live getter so tests that
    // reassign `provider._cache` see the new instance.
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
      get cache() {
        return provider._cache;
      },
      get token() {
        // Honour the constructor's explicit `opts.token` so the
        // projects-v2-graphql shim does not fall through to resolveToken()
        // (which shells to `gh auth token` and throws in CI environments
        // without a real token). Returns null when no explicit token was
        // supplied — the shim then resolves lazily as before.
        return provider._memoizedToken;
      },
      state: { projectId: null },
      hooks: {
        getTicket: (id, o) => provider.getTicket(id, o),
        addItemToProject: (nodeId) =>
          projects.addItemToProject(this._ctx, nodeId),
      },
    };
  }

  get token() {
    if (this._memoizedToken) return this._memoizedToken;
    this._memoizedToken = resolveToken();
    return this._memoizedToken;
  }

  // -------------------------------------------------------------------------
  // Raw GraphQL — routes through `gh api graphql` (same `_ghGraphql` shim
  // the sub-issue mutations use). Callers (`epic-reconcile.js`,
  // `epic-runner/column-sync.js`) pass `query, variables, opts` exactly as
  // they did against the old bespoke client.
  // -------------------------------------------------------------------------
  async graphql(query, variables = {}, opts = {}) {
    return this._ghGraphql(query, variables, opts);
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
    return this.tickets.getTickets(epicId, filters);
  }

  /**
   * Strategy 1 — native GitHub Sub-Issues via GraphQL. Paginates and seeds
   * the ticket cache. Returns `[]` (not throw) when the feature is disabled
   * on this repo.
   */
  async _getNativeSubIssues(parentNodeId, parentId) {
    return this.subIssues.getNativeSubIssues(parentNodeId, parentId);
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
    return this.tickets.getTicket(ticketId, opts);
  }

  primeTicketCache(tickets) {
    this.tickets.primeTicketCache(tickets);
  }

  invalidateTicket(ticketId) {
    this.tickets.invalidateTicket(ticketId);
  }

  /* node:coverage ignore next */
  async getTicketDependencies(ticketId) {
    return this.tickets.getTicketDependencies(ticketId);
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
    return this.tickets.createTicket(parentId, ticketData);
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
    return this.subIssues.addSubIssue(parentNumber, childNodeId, opts);
  }

  async removeSubIssue(parentNumber, subIssueNumber) {
    return this.subIssues.removeSubIssue(parentNumber, subIssueNumber);
  }

  /**
   * Walk every child of `epicId` whose body footer carries `parent: #N` and
   * verify the native sub-issue link is present. Re-establish missing links
   * via `addSubIssue` (which retries internally). Idempotent.
   */
  async reconcileSubIssueLinks(epicId) {
    return this.subIssues.reconcileSubIssueLinks(epicId);
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
  async _applyLabelMutations(
    ticketId,
    labelMutations,
    hasOtherPatchFields,
    ticketSnapshot = null,
  ) {
    return this.tickets._applyLabelMutations(
      ticketId,
      labelMutations,
      hasOtherPatchFields,
      ticketSnapshot,
    );
  }

  /**
   * @field-manifest PATCH /repos/{owner}/{repo}/issues/{n}:
   *                 body, assignees, state, state_reason, labels
   */
  /* node:coverage ignore next */
  async updateTicket(ticketId, mutations) {
    return this.tickets.updateTicket(ticketId, mutations);
  }

  // =========================================================================
  // COMMENT SURFACE — delegated to CommentGateway (Story #2462 / Task #2480)
  // =========================================================================

  async getRecentComments(limit = 100) {
    return this.comments.getRecentComments(limit);
  }

  async getTicketComments(ticketId) {
    return this.comments.getTicketComments(ticketId);
  }

  async deleteComment(commentId) {
    return this.comments.deleteComment(commentId);
  }

  async postComment(ticketId, payload) {
    return this.comments.postComment(ticketId, payload);
  }

  // =========================================================================
  // BRANCH-PROTECTION + PR SURFACE — rewritten on gh-exec (Task #1371)
  //
  // The old `./github/branches.js` submodule is still on disk (Wave 3
  // deletes it) but is no longer reached. Both `getBranchProtection` and
  // `setBranchProtection` go through `gh.api`; `createPullRequest` goes
  // through `gh.pr.create` and follows up with `gh.pr.view` to harvest
  // the canonical {number, url, nodeId} envelope the legacy
  // ticket-mapper round-tripped.
  // =========================================================================

  /**
   * Probe whether `branch` exists on the remote. Returns `true` when the
   * branch resolves, `false` on 404 (branch not pushed yet — e.g. a
   * fresh-empty-repo bootstrap before the first commit lands on
   * `main`), and propagates any other transport error so auth/scope
   * failures don't masquerade as a missing branch.
   *
   * Used by `lib/bootstrap/branch-protection.js` to short-circuit the
   * protection write on empty repos with a clean "no-base-branch" skip
   * rather than failing the PUT (Story #2018, Bug 3).
   *
   * @field-manifest GET /repos/{owner}/{repo}/branches/{branch}: name
   */
  async branchExists(branch) {
    const endpoint = `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}`;
    try {
      await this._gh.api({ method: 'GET', endpoint });
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  async getBranchProtection(branch) {
    return this.branchProtection.getBranchProtection(branch);
  }

  async setBranchProtection(branch, opts) {
    return this.branchProtection.setBranchProtection(branch, opts);
  }

  /**
   * Open a Pull Request linking `ticketId` to `branchName` against
   * `baseBranch`. Uses `gh pr create` for the create call (the canonical
   * gh-CLI subcommand for this surface) and follows up with `gh pr view`
   * to harvest the JSON envelope (`{number, url, id}`) — `pr create` itself
   * only emits the html_url on stdout.
   *
   * Returns `{ number, url, htmlUrl, nodeId }` — a superset of the legacy
   * `{number, url, htmlUrl}` shape with `nodeId` added so callers no longer
   * need a follow-up `getTicket` to add the PR to a Project V2.
   */
  /* node:coverage ignore next */
  async createPullRequest(branchName, ticketId, baseBranch = 'main') {
    const ticket = await this.getTicket(ticketId);

    const createResult = await this._gh.pr.create([
      '--title',
      ticket.title,
      '--body',
      `Closes #${ticketId}`,
      '--base',
      baseBranch,
      '--head',
      branchName,
    ]);
    const htmlUrl = (createResult?.stdout ?? '').trim();

    // `gh pr view <url> --json number,url,id` returns the canonical
    // numeric id, api url, and node id we need for the {number, url,
    // nodeId} envelope and for the Project V2 link below.
    const viewResult = await this._gh.pr.view(htmlUrl, ['number', 'url', 'id']);
    const view = JSON.parse(viewResult?.stdout ?? '{}');

    try {
      if (this.projectNumber && view.id) {
        await this._ctx.hooks.addItemToProject(view.id);
      }
    } catch (err) {
      Logger.warn(
        `[GitHubProvider] Failed to add PR #${view.number} to project: ${err.message}`,
      );
    }

    return {
      number: view.number,
      url: view.url,
      htmlUrl,
      nodeId: view.id,
    };
  }

  // =========================================================================
  // LABEL + MERGE-METHOD SURFACE — rewritten on gh-exec (Task #1373)
  //
  // `ensureLabels` shells to `gh label create` per labelDef and swallows
  // "already exists" as the idempotent skip path — this is cheaper than
  // a pre-list because `gh label create` is a single round-trip, GitHub
  // already enforces uniqueness on `name`, and the duplicate signal is
  // surfaced verbatim by the CLI on stderr. `getMergeMethods` /
  // `setMergeMethods` route through `gh.api` against `/repos/{owner}/{repo}`,
  // returning the same `{...mergeFields}` / `{patched}` envelopes the
  // bootstrap (`lib/bootstrap/merge-methods.js`,
  // `agents-bootstrap-github.js`) already consumes.
  // =========================================================================

  async ensureLabels(labelDefs) {
    return this.labels.ensureLabels(labelDefs);
  }

  async _reconcileLabelsPresence(labelDefs) {
    return this.labels._reconcileLabelsPresence(labelDefs);
  }

  _normalizeLabelListResult(result) {
    return this.labels._normalizeLabelListResult(result);
  }

  /**
   * Read the repo's current merge-method-related settings. Returns only
   * the fields the bootstrap cares about so the diff layer can compare
   * apples to apples regardless of what other knobs the repo exposes.
   *
   * @field-manifest GET /repos/{owner}/{repo}: allow_squash_merge,
   *                 allow_rebase_merge, allow_merge_commit,
   *                 allow_auto_merge, delete_branch_on_merge
   */
  async getMergeMethods() {
    const result = await this._gh.api({
      method: 'GET',
      endpoint: `/repos/${this.owner}/${this.repo}`,
    });
    const raw = parseApiJson(result) ?? {};
    const out = {};
    for (const field of MERGE_METHOD_FIELDS) {
      if (Object.hasOwn(raw, field)) out[field] = raw[field];
    }
    return out;
  }

  /**
   * PATCH the repo with the supplied merge-method settings. Sparse body —
   * only the supplied fields are sent / touched.
   *
   * @field-manifest PATCH /repos/{owner}/{repo}: allow_squash_merge,
   *                 allow_rebase_merge, allow_merge_commit,
   *                 allow_auto_merge, delete_branch_on_merge
   */
  async setMergeMethods(settings) {
    const body = {};
    for (const field of MERGE_METHOD_FIELDS) {
      if (Object.hasOwn(settings, field)) body[field] = settings[field];
    }
    await this._gh.api({
      method: 'PATCH',
      endpoint: `/repos/${this.owner}/${this.repo}`,
      body,
    });
    return { patched: Object.keys(body) };
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
