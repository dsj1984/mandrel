/**
 * GitHub Provider — every surface routes through gh-exec
 * (Epic #1179, Wave 3 / Story #1363 — final cutover).
 *
 * Wave 0 landed `lib/gh-exec.js`. Waves 1–2 migrated the issue, comment,
 * branch-protection, PR, label, merge-method, repo, and branches surfaces
 * onto `gh.api` / `gh.pr.*` / `gh.label.*` / `gh.repo.*`, and collapsed the
 * Projects V2 helpers into a single self-contained shim at
 * `./github/projects-v2-graphql.js`. **This file is now the only resolution
 * path.** The legacy submodule tree (`./github/auth.js`, `./github/http.js`,
 * `./github/issues.js`, etc.) is deleted; the only remaining file under
 * `./github/` is the projects-v2-graphql shim.
 *
 * What used to live in submodules now lives here as the helpers immediately
 * below:
 *
 *   - `resolveToken` / `__setExecSyncForTests` — token resolution
 *     (env → `gh auth token` fallback). Memoizes to `GITHUB_TOKEN` exactly
 *     once. Used by callers that historically reached for `provider.token`
 *     (currently a single test); the rest of the provider routes through
 *     gh-exec, which owns its own auth.
 *
 *   - `classifyGithubError` — normalises transport errors into
 *     `feature-disabled` / `permission` / `transient` / `permanent` so the
 *     sub-issues fallback and the retry loop have a deterministic switch.
 *
 *   - `ADD_SUB_ISSUE_MUTATION` / `REMOVE_SUB_ISSUE_MUTATION` /
 *     `SUB_ISSUES_QUERY` — the three GraphQL shapes the sub-issues feature
 *     reads/writes. `_ghGraphql` shells these out via `gh api graphql`.
 *
 *   - `issueToTicket` / `issueToEpic` / `issueToListItem` /
 *     `issueToEpicListItem` / `subIssueNodeToTicket` — pure mappers that
 *     translate REST/GraphQL payloads into the normalized ticket shape the
 *     orchestration layer consumes. Pure functions, no I/O.
 *
 *   - `createInlineTicketCache` — per-instance ticket cache (one bare
 *     `Map<id, { ticket, insertedAt }>`) shared by dispatcher, reconciler,
 *     and cascade. The old TTL wrapper is gone because `peekFresh` already
 *     bounds entries by a caller-supplied `maxAgeMs`.
 *
 * `graphql(query, variables, opts)` now routes through `_ghGraphql` (i.e.
 * `gh api graphql`) so callers like `delete-epic.js` and `epic-runner/
 * column-sync.js` keep their public surface unchanged after the
 * `GithubHttpClient` deletion.
 *
 * The only remaining import from `./github/` is the projects-v2-graphql shim
 * — Projects V2 is its own scope and lives there.
 *
 * @see docs/v5-implementation-plan.md (legacy reference — superseded by
 *      Epic #1179 Tech Spec #1350).
 */

import { execSync as defaultExecSync } from 'node:child_process';
import { parseBlockedBy, parseBlocks } from '../lib/dependency-parser.js';
import { gh as defaultGh } from '../lib/gh-exec.js';
import { ITicketingProvider } from '../lib/ITicketingProvider.js';
import { parseLinkedIssues } from '../lib/issue-link-parser.js';
import { Logger } from '../lib/Logger.js';
import { TYPE_LABELS } from '../lib/label-constants.js';
import { composeTaskBody } from '../lib/templates/task-body-renderer.js';
import { concurrentMap } from '../lib/util/concurrent-map.js';
import * as projects from './github/projects-v2-graphql.js';

// ---------------------------------------------------------------------------
// Token resolution (inlined from the retired `./github/auth.js`)
//
// Hierarchy: GITHUB_TOKEN / GH_TOKEN env → `gh auth token` CLI fallback
// → throws with an instructive error. `execSync` is indirected through a
// holder so the (now-deleted) token-memoize test could swap it — the holder
// + setter stay for back-compat with any external caller that reaches for
// the test seam. Production always uses the real impl.
// ---------------------------------------------------------------------------
const execSyncHolder = { impl: defaultExecSync };

export function __setExecSyncForTests(fn) {
  execSyncHolder.impl = fn ?? defaultExecSync;
}

/* node:coverage ignore next */
function resolveToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) return token;

  try {
    const ghToken = execSyncHolder
      .impl('gh auth token', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      .trim();
    if (ghToken) {
      if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = ghToken;
      return ghToken;
    }
  } catch {
    // gh CLI not installed or not authenticated.
  }

  throw new Error(
    [
      '[GitHubProvider] Authentication Failed: No GitHub token found.',
      '',
      'To resolve this, choose one of the following:',
      '  A. (CI/CD / Agent Script) Set the GITHUB_TOKEN or GH_TOKEN environment variable.',
      '  B. (Local) Run `gh auth login` to authenticate the GitHub CLI.',
      '',
      'See .agents/scripts/lib/orchestration/README.md#authentication for details.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Error classifier (inlined from the retired `./github/error-classifier.js`)
//
// Buckets `gh-exec`-thrown errors into 4 categories so the sub-issues
// fallback and the addSubIssue retry loop have a deterministic switch.
// Rate-limit detection wins over the 401/403 → permission rule because
// GitHub's secondary rate limit is delivered as HTTP 403 with a known
// message; if we bucketed it as 'permission' it would never be retried.
// ---------------------------------------------------------------------------
const FEATURE_DISABLED_MESSAGES = [
  'feature not available',
  'feature is not enabled',
  "field 'subissues'",
  'field "subissues"',
  'subissues is not available',
  'sub-issues',
  "doesn't exist on type",
  'does not exist on type',
  'unknown field',
];

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
]);

const TRANSIENT_MESSAGES = [
  'rate limit',
  'secondary rate limit',
  'abuse detection',
  'fetch failed',
  'network',
  'timeout',
  'timed out',
  'aborted',
];

const PERMISSION_MESSAGES = ['unauthorized', 'forbidden', 'permission'];

function matchesAny(haystack, needles) {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

function classifyGithubError(err) {
  if (!err) return 'permanent';

  const message = typeof err.message === 'string' ? err.message : String(err);
  const lower = message.toLowerCase();
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = typeof err.code === 'string' ? err.code : undefined;

  if (matchesAny(lower, FEATURE_DISABLED_MESSAGES)) return 'feature-disabled';

  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return 'transient';
  }
  if (TRANSIENT_CODES.has(code) || matchesAny(lower, TRANSIENT_MESSAGES)) {
    return 'transient';
  }

  if (status === 401 || status === 403) return 'permission';
  if (matchesAny(lower, PERMISSION_MESSAGES)) return 'permission';

  return 'permanent';
}

// ---------------------------------------------------------------------------
// Sub-issues GraphQL shapes (inlined from the retired `./github/graphql-builder.js`)
// ---------------------------------------------------------------------------
const SUB_ISSUES_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue {
      subIssues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
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
  }
}`;

const ADD_SUB_ISSUE_MUTATION = `
  mutation($parentId: ID!, $subIssueId: ID!, $replaceParent: Boolean) {
    addSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId, replaceParent: $replaceParent }) {
      issue { number }
      subIssue { number }
    }
  }`;

const REMOVE_SUB_ISSUE_MUTATION = `
  mutation($parentId: ID!, $subIssueId: ID!) {
    removeSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
      issue { number }
      subIssue { number }
    }
  }`;

// ---------------------------------------------------------------------------
// Ticket mappers (inlined from the retired `./github/ticket-mapper.js`)
//
// Pure functions that translate raw GitHub API payloads (REST Issue,
// GraphQL sub-issue node) into the normalized ticket shape consumed
// throughout the orchestration layer. No I/O, no state.
// ---------------------------------------------------------------------------
function normalizeLabels(issue) {
  const raw = issue?.labels;
  if (!raw) return [];
  if (Array.isArray(raw?.nodes)) {
    return raw.nodes.map((l) => l.name);
  }
  if (Array.isArray(raw)) {
    return raw.map((l) => (typeof l === 'string' ? l : l.name));
  }
  return [];
}

function issueToTicket(issue) {
  const labels = normalizeLabels(issue);
  return {
    id: issue.number,
    internalId: issue.id,
    nodeId: issue.node_id,
    title: issue.title,
    body: issue.body ?? '',
    labels,
    labelSet: new Set(labels),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    state: issue.state,
  };
}

function issueToEpic(issue) {
  const labels = normalizeLabels(issue);
  return {
    id: issue.number,
    internalId: issue.id,
    nodeId: issue.node_id,
    title: issue.title,
    body: issue.body ?? '',
    labels,
    labelSet: new Set(labels),
    linkedIssues: parseLinkedIssues(issue.body),
  };
}

function subIssueNodeToTicket(node) {
  const labels = normalizeLabels(node);
  return {
    id: node.number,
    internalId: node.databaseId,
    nodeId: node.id,
    title: node.title,
    body: node.body ?? '',
    labels,
    labelSet: new Set(labels),
    assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
    state:
      typeof node.state === 'string' ? node.state.toLowerCase() : node.state,
  };
}

function issueToListItem(issue) {
  const labels = normalizeLabels(issue);
  return {
    id: issue.number,
    internalId: issue.id,
    nodeId: issue.node_id,
    title: issue.title,
    body: issue.body ?? '',
    labels,
    labelSet: new Set(labels),
    state: issue.state,
  };
}

function issueToEpicListItem(issue) {
  const labels = normalizeLabels(issue);
  return {
    id: issue.number,
    title: issue.title,
    labels,
    labelSet: new Set(labels),
    state: issue.state,
    state_reason: issue.state_reason,
  };
}

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

// ---------------------------------------------------------------------------
// Structured-comment badge — preserved verbatim from the old
// `./github/comments.js`. `upsertStructuredComment` in
// `lib/orchestration/ticketing.js` prepends the `<!-- ap:structured-comment
// ... -->` marker before the body reaches `postComment`; this badge is the
// visible header consumers (Slack notifier, dashboard) grep for. Keeping the
// emoji + bold marker stable is what makes the round-trip with structured-
// comment detection work across the rewrite.
// ---------------------------------------------------------------------------
const TYPE_BADGES = {
  progress: '🔄 **Progress**',
  friction: '⚠️ **Friction**',
  notification: '📢 **Notification**',
};

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
 * Detect a 404 across both error surfaces:
 *
 *   - `gh-exec`-classified errors land as `GhNotFoundError`
 *     (`err.name === 'GhNotFoundError'`); the underlying stderr may carry
 *     "HTTP 404" / "not found" / "Resource not accessible".
 *   - The legacy `GithubHttpClient` produced `Error('... failed (404): ...')`
 *     strings; some tests still throw those (and submodules that still
 *     delegate to the old transport do too).
 *
 * Used by `getBranchProtection` to distinguish "no rule exists" from
 * "transport failure."
 */
function isNotFoundError(err) {
  if (!err) return false;
  if (err.name === 'GhNotFoundError') return true;
  const message = err?.message ?? '';
  const stderr = err?.stderr ?? '';
  return (
    /failed \(404\)/.test(message) ||
    /HTTP 404/i.test(stderr) ||
    /HTTP 404/i.test(message) ||
    /\bnot found\b/i.test(stderr) ||
    // gh-exec carries the failing code on err.code for the test mock path.
    err?.code === 404
  );
}

/**
 * Detect the "label already exists" signal across the surfaces `gh label
 * create` can emit it on. The CLI prints
 *
 *   `! Label "<name>" already exists`
 *
 * to stderr and exits non-zero; the underlying API surfaces a 422 with
 * `errors[].code === 'already_exists'`. The test mock throws
 * `Error('... code 422')`. Match all three.
 */
function isLabelAlreadyExistsError(err) {
  if (!err) return false;
  const message = err?.message ?? '';
  const stderr = err?.stderr ?? '';
  if (/already exists/i.test(stderr) || /already exists/i.test(message)) {
    return true;
  }
  if (/already_exists/i.test(stderr)) return true;
  return false;
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

/**
 * Per-instance ticket cache, inlined from the (now retired)
 * `./github/cache-manager.js` factory. One bare `Map<id, { ticket, insertedAt }>`
 * scoped to the lifetime of a single `GitHubProvider`, shared by dispatcher,
 * reconciler, and cascade. We deliberately drop the outer TTL wrapper here
 * because `peekFresh` already bounds entries by a caller-supplied `maxAgeMs`,
 * and every other reader (`getTicket` without `maxAgeMs`) trusts the
 * orchestration mutators (`updateTicket` / `postComment` / `addSubIssue` /
 * `removeSubIssue`) to call `invalidate` explicitly.
 *
 * Surface is intentionally narrower than the old `createTicketCacheManager`:
 * only methods the provider itself reaches for live here (`has` / `peek` /
 * `peekFresh` / `set` / `primeIfAbsent` / `primeMany` / `invalidate`). The
 * `getOrLoad` / `clear` helpers stayed behind in `./github/cache-manager.js`
 * for the test suites that exercise that factory directly — Wave 3 deletes
 * the file.
 *
 * @param {{ now?: () => number }} [opts]
 * @returns {{
 *   has(ticketId: number): boolean,
 *   peek(ticketId: number): object|undefined,
 *   peekFresh(ticketId: number, maxAgeMs: number): object|undefined,
 *   set(ticketId: number, ticket: object): void,
 *   primeIfAbsent(ticket: object): void,
 *   primeMany(tickets: Array<object>): void,
 *   invalidate(ticketId: number): void,
 * }}
 */
function createInlineTicketCache({ now = Date.now } = {}) {
  /** @type {Map<number, { ticket: object, insertedAt: number }>} */
  const store = new Map();

  function primeIfAbsent(ticket) {
    if (!ticket || typeof ticket.id !== 'number') return;
    if (store.has(ticket.id)) return;
    if (!ticket.labelSet && Array.isArray(ticket.labels)) {
      ticket.labelSet = new Set(ticket.labels);
    }
    store.set(ticket.id, { ticket, insertedAt: now() });
  }

  return {
    has(ticketId) {
      return store.has(ticketId);
    },

    peek(ticketId) {
      return store.get(ticketId)?.ticket;
    },

    peekFresh(ticketId, maxAgeMs) {
      const entry = store.get(ticketId);
      if (!entry) return undefined;
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return undefined;
      if (now() - entry.insertedAt >= maxAgeMs) return undefined;
      return entry.ticket;
    },

    set(ticketId, ticket) {
      store.set(ticketId, { ticket, insertedAt: now() });
    },

    primeIfAbsent,

    primeMany(tickets) {
      for (const t of tickets ?? []) primeIfAbsent(t);
    },

    invalidate(ticketId) {
      store.delete(ticketId);
    },
  };
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

    // ctx is the shared object the projects-v2-graphql shim reads from.
    // `projectNumber` gets a live getter/setter so `resolveOrCreateProject`
    // can mutate it on demand; `cache` is a live getter so tests that
    // reassign `provider._cache` see the new instance.
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
  // the sub-issue mutations use). Callers (`delete-epic.js`,
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
        const result = await this._ghGraphql(
          ADD_SUB_ISSUE_MUTATION,
          {
            parentId: parentTicket.nodeId,
            subIssueId: childNodeId,
            replaceParent: opts.replaceParent,
          },
          { headers: { 'GraphQL-Features': 'sub_issues' } },
        );
        // Sub-issue link mutates the parent's sub-issue list (which
        // `getSubTickets` derives partly via the GraphQL `subIssues` field on
        // the parent node). Invalidate so the next `getTicket(parentNumber)`
        // re-fetches a coherent view.
        this.invalidateTicket(parentNumber);
        return result;
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
    const result = await this._ghGraphql(
      REMOVE_SUB_ISSUE_MUTATION,
      { parentId: parentTicket.nodeId, subIssueId: childTicket.nodeId },
      { headers: { 'GraphQL-Features': 'sub_issues' } },
    );
    // Sub-issue unlink mutates the parent's sub-issue list. Invalidate both
    // ends so subsequent reads see the post-mutation shape.
    this.invalidateTicket(parentNumber);
    this.invalidateTicket(subIssueNumber);
    return result;
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
  // COMMENT SURFACE — rewritten on gh-exec (Task #1372)
  // =========================================================================

  /**
   * Recent comments across all issues in the repo (sorted newest first).
   * Used by reconcilers that look for state changes (e.g. structured-comment
   * sweeps) without paginating each ticket individually.
   *
   * @field-manifest /repos/{owner}/{repo}/issues/comments?sort=created:
   *                 id, body, created_at, user, issue_url
   */
  async getRecentComments(limit = 100) {
    const result = await this._gh.api({
      method: 'GET',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/comments?sort=created&direction=desc&per_page=${limit}`,
    });
    return parseApiJson(result) ?? [];
  }

  /**
   * All comments on a single ticket. Used by `findStructuredComment` in
   * `lib/orchestration/ticketing.js`, which greps each comment body for the
   * `<!-- ap:structured-comment type="..." -->` marker — so the per-comment
   * `body` field must round-trip verbatim.
   *
   * @field-manifest /repos/{owner}/{repo}/issues/{n}/comments:
   *                 id, body, created_at, user
   */
  async getTicketComments(ticketId) {
    return paginateRest(
      this._gh,
      `/repos/${this.owner}/${this.repo}/issues/${ticketId}/comments`,
    );
  }

  /**
   * Delete a comment by id. Called by `upsertStructuredComment` before
   * posting the replacement, so the in-place semantics hold even though the
   * underlying GitHub API has no native upsert.
   */
  async deleteComment(commentId) {
    await this._gh.api({
      method: 'DELETE',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`,
    });
  }

  /**
   * Post a comment on an issue. When `payload.type` matches a known
   * structured-comment kind, prepend the visible type-badge so operators see
   * the same header the old client produced. The
   * `<!-- ap:structured-comment ... -->` marker is added by the caller
   * (`upsertStructuredComment` in `lib/orchestration/ticketing.js`) — this
   * method does not double-emit it.
   *
   * Accepts either `{ body, type }` (canonical) or a bare string (legacy
   * shape exercised by `tests/lib/github-provider.test.js` and a handful of
   * direct callers under `notify.js`).
   *
   * @field-manifest POST /repos/{owner}/{repo}/issues/{n}/comments:
   *                 id (returned for the caller's `commentId`)
   */
  async postComment(ticketId, payload) {
    const normalized =
      typeof payload === 'string' ? { body: payload } : (payload ?? {});
    const badge = TYPE_BADGES[normalized.type] ?? '';
    const body = badge ? `${badge}\n\n${normalized.body}` : normalized.body;

    const result = await this._gh.api({
      method: 'POST',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}/comments`,
      body: { body },
    });
    const comment = parseApiJson(result);
    // Posting a comment mutates the ticket's comment thread. Invalidate so
    // the next `getTicketComments` / `getTicket` reflects the new comment.
    this.invalidateTicket(ticketId);
    return { commentId: comment.id };
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
   * Inspect branch-protection state. A 404 means "no protection rule
   * exists"; any other error propagates so the caller can distinguish
   * "intentionally unprotected" from "transport failure." The 404 detect
   * matches both the legacy bespoke-client phrasing (`failed (404)`) and
   * the `gh-exec` classified path (`GhNotFoundError`/stderr containing
   * "HTTP 404" / "Not Found").
   *
   * @field-manifest GET /repos/{owner}/{repo}/branches/{branch}/protection:
   *                 required_status_checks, enforce_admins,
   *                 required_pull_request_reviews, restrictions
   */
  async getBranchProtection(branch) {
    const endpoint = `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}/protection`;
    try {
      const result = await this._gh.api({ method: 'GET', endpoint });
      const raw = parseApiJson(result) ?? {};
      return { enabled: true, raw };
    } catch (err) {
      if (isNotFoundError(err)) return { enabled: false };
      throw err;
    }
  }

  /**
   * Set (create or merge) branch protection on `branch`. Additive on the
   * required-status-check `contexts` list (preserves operator-added
   * contexts), and honours optional behaviour-shifting overrides
   * (`enforceAdmins`, `requiredApprovingReviewCount`) so the consumer-
   * facing bootstrap can promote the framework's hands-off-pipeline
   * stance without silently flipping operator-tuned values.
   *
   * Returns `{ created, added, existing }` — the same shape
   * `agents-bootstrap-github.js` and `lib/bootstrap/branch-protection.js`
   * already consume.
   *
   * @field-manifest PUT /repos/{owner}/{repo}/branches/{branch}/protection:
   *                 required_status_checks, enforce_admins,
   *                 required_pull_request_reviews, restrictions
   *
   * @param {string} branch
   * @param {{
   *   contexts: string[],
   *   strict?: boolean,
   *   enforceAdmins?: boolean,
   *   requiredApprovingReviewCount?: number,
   * }} opts
   */
  async setBranchProtection(branch, opts) {
    const contexts = Array.isArray(opts?.contexts) ? opts.contexts : [];
    const strict = opts?.strict !== false;
    const endpoint = `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}/protection`;

    const current = await this.getBranchProtection(branch);
    const existingContexts = current.enabled
      ? (current.raw?.required_status_checks?.contexts ?? [])
      : [];

    // Additive merge: keep every context the operator already configured
    // and append only those the prGate suite contributes that are not yet
    // present.
    const merged = [...existingContexts];
    const added = [];
    for (const ctx of contexts) {
      if (!merged.includes(ctx)) {
        merged.push(ctx);
        added.push(ctx);
      }
    }

    // Decide whether to override behaviour-shifting fields. Explicit
    // `undefined` from legacy callers falls through to the operator's
    // existing values (or the create-from-scratch defaults).
    const overrideEnforceAdmins = typeof opts?.enforceAdmins === 'boolean';
    const overrideApprovalCount =
      typeof opts?.requiredApprovingReviewCount === 'number';

    let enforceAdmins;
    if (overrideEnforceAdmins) {
      enforceAdmins = opts.enforceAdmins;
    } else if (current.enabled) {
      enforceAdmins = current.raw?.enforce_admins?.enabled ?? false;
    } else {
      enforceAdmins = false;
    }

    let prReviews;
    if (overrideApprovalCount) {
      // Preserve operator-set review flags (dismiss-stale, code-owners,
      // etc.) — only the count is promoted.
      const baseReviews = current.enabled
        ? (current.raw?.required_pull_request_reviews ?? {})
        : {};
      prReviews = {
        ...baseReviews,
        required_approving_review_count: opts.requiredApprovingReviewCount,
      };
    } else {
      prReviews = current.enabled
        ? (current.raw?.required_pull_request_reviews ?? null)
        : null;
    }

    // PUT requires every top-level field in the body — null disables a
    // section.
    const body = current.enabled
      ? {
          required_status_checks: {
            strict: current.raw?.required_status_checks?.strict ?? strict,
            contexts: merged,
          },
          enforce_admins: enforceAdmins,
          required_pull_request_reviews: prReviews,
          restrictions: current.raw?.restrictions ?? null,
        }
      : {
          required_status_checks: { strict, contexts: merged },
          enforce_admins: enforceAdmins,
          required_pull_request_reviews: prReviews,
          restrictions: null,
        };

    await this._gh.api({ method: 'PUT', endpoint, body });

    return {
      created: !current.enabled,
      added,
      existing: existingContexts,
    };
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

  /**
   * Idempotent label creation. For each labelDef, attempt `gh label create
   * <name> --color <hex> --description <text>`. The CLI prints
   * "label already exists" (or the API surfaces a 422
   * "already_exists" error) when the name is taken; we swallow that and
   * count it as `skipped`. Any other error propagates so transport faults
   * stay loud.
   *
   * Returns `{ created: string[], skipped: string[] }` — the same shape
   * `agents-bootstrap-github.js` already reads.
   */
  async ensureLabels(labelDefs) {
    const created = [];
    const skipped = [];
    for (const def of labelDefs) {
      const color = (def.color ?? '').replace(/^#/, '');
      try {
        await this._gh.label.create(def.name, [
          '--color',
          color,
          '--description',
          def.description ?? '',
        ]);
        created.push(def.name);
      } catch (err) {
        if (isLabelAlreadyExistsError(err)) {
          skipped.push(def.name);
          continue;
        }
        throw err;
      }
    }
    return { created, skipped };
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
