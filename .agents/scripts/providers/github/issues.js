/**
 * GitHub Issues — read/write ticket operations.
 *
 * Pure functions over a `ctx` object (`{ owner, repo, http, cache, hooks }`).
 * No imports from sibling submodules under `providers/github/` — cross-cutting
 * concerns (project-add on create, etc.) are threaded in through `ctx.hooks`
 * and wired up by the facade.
 */

import { parseBlockedBy, parseBlocks } from '../../lib/dependency-parser.js';
import { Logger } from '../../lib/Logger.js';
import { TYPE_LABELS } from '../../lib/label-constants.js';
import { composeTaskBody } from '../../lib/templates/task-body-renderer.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { classifyGithubError } from './error-classifier.js';
import { runGraphql } from './graphql.js';
import {
  ADD_SUB_ISSUE_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  SUB_ISSUES_QUERY,
} from './graphql-builder.js';
import {
  issueToEpic,
  issueToEpicListItem,
  issueToListItem,
  issueToTicket,
  subIssueNodeToTicket,
} from './ticket-mapper.js';

const SUBTICKET_HYDRATION_CONCURRENCY = 8;

// Cap=4 — bounded parallelism for sub-issue link reconciliation. Each
// parent's link work is independent of its siblings' link work, and within
// a parent each child's `addSubIssue` call is independent of its siblings'.
// Cap matches the orchestration-layer house style (wave-gate, reconciler)
// and stays under the secondary rate-limit ceiling for issue-link mutations.
const SUB_ISSUE_RECONCILE_CONCURRENCY = 4;

// Retry budget for the sub-issue link mutation. The HTTP transport already
// retries 429 / 5xx / 403-secondary-RL at the network layer; this layer adds
// resilience for GraphQL-200 + errors[] (rate-limit messages surfaced inside
// a successful HTTP response — see error-classifier.js). Six attempts with
// jittered exp backoff up to 30s comfortably outlasts the secondary RL window
// observed on >80-ticket Epic decompositions.
const SUB_ISSUE_RETRY_MAX_ATTEMPTS = 6;
const SUB_ISSUE_RETRY_BASE_DELAY_MS = 1000;
const SUB_ISSUE_RETRY_MAX_DELAY_MS = 30000;
const SUB_ISSUE_RETRY_JITTER_MS = 500;

/* node:coverage ignore next */
export async function listIssues(ctx, filters = {}) {
  return getEpics(ctx, filters);
}

export async function listIssuesByLabel(ctx, { state = 'open', labels } = {}) {
  const params = new URLSearchParams({ state });
  if (labels) params.set('labels', labels);
  const issues = await ctx.http.restPaginated(
    `/repos/${ctx.owner}/${ctx.repo}/issues?${params}`,
  );
  return issues.filter((issue) => !issue?.pull_request);
}

/* node:coverage ignore next */
export async function getEpics(ctx, filters = {}) {
  const params = new URLSearchParams({
    state: filters.state ?? 'all',
    labels: TYPE_LABELS.EPIC,
  });

  const issues = await ctx.http.restPaginated(
    `/repos/${ctx.owner}/${ctx.repo}/issues?${params}`,
  );

  return issues.filter((issue) => !issue.pull_request).map(issueToEpicListItem);
}

export async function getEpic(ctx, epicId) {
  const issue = await ctx.http.rest(
    `/repos/${ctx.owner}/${ctx.repo}/issues/${epicId}`,
  );
  return issueToEpic(issue);
}

/* node:coverage ignore next */
export async function getTickets(ctx, epicId, filters = {}) {
  const params = new URLSearchParams({
    state: filters.state ?? 'all',
  });
  if (filters.label) {
    params.set('labels', filters.label);
  }

  const issues = await ctx.http.restPaginated(
    `/repos/${ctx.owner}/${ctx.repo}/issues?${params}`,
  );

  // Word-boundary regex prevents #1 matching #10, #100, etc. (C-2).
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
 * Strategy 1 — primary source: native GitHub Sub-Issues (v5 source of truth).
 * Paginates the GraphQL `subIssues` connection, seeding the ticket cache so
 * the caller's subsequent `getTicket` calls resolve from memory. Returns an
 * empty list (not throw) when the feature is disabled on this repo.
 */
export async function getNativeSubIssues(ctx, parentNodeId, parentId) {
  const childIds = [];
  let cursor = null;
  try {
    while (true) {
      const subIssuesPage = await runGraphql(
        ctx,
        SUB_ISSUES_QUERY,
        { id: parentNodeId, cursor },
        { headers: { 'GraphQL-Features': 'sub_issues' } },
      );

      const page = subIssuesPage.node?.subIssues;
      const nodes = page?.nodes ?? [];
      for (const node of nodes) {
        childIds.push(node.number);
        ctx.cache.primeIfAbsent(subIssueNodeToTicket(node));
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

/**
 * Strategy 2 — secondary: parse Markdown checklist links of the form
 * `- [ ] #123` / `- [x] #123` out of the parent body. Pure parsing.
 */
export function getChecklistChildren(parentBody) {
  const re = /-\s*\[[ xX]\]\s+#(\d+)/g;
  return [...(parentBody ?? '').matchAll(re)].map((m) =>
    Number.parseInt(m[1], 10),
  );
}

/**
 * Strategy 3 — tertiary: reverse-search for issues that reference the parent
 * (`Epic: #N` / `parent: #N`). Runs for any parent type so Stories resolve
 * their child Tasks the same way Epics resolve their Stories. Non-fatal on
 * error.
 */
export async function getReferencedChildren(ctx, parentId) {
  try {
    const issues = await getTickets(ctx, parentId);
    primeTicketCache(ctx, issues);
    return issues.map((i) => i.id);
  } catch (err) {
    Logger.warn(
      `[GitHubProvider] reverse dependency lookup (parent #${parentId}): ${err.message}`,
    );
    return [];
  }
}

export async function getSubTickets(ctx, parentId) {
  const parent = await getTicket(ctx, parentId);

  const [nativeChildIds, checklistChildIds, referencedChildIds] =
    await Promise.all([
      getNativeSubIssues(ctx, parent.nodeId, parentId),
      Promise.resolve(getChecklistChildren(parent.body)),
      getReferencedChildren(ctx, parentId),
    ]);

  // Dedupe while preserving the historical fallback order: native first,
  // then checklist, then reverse-referenced.
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
      getTicket(ctx, id).catch((err) => {
        // Failure-signal preservation: per-child fetch errors used to be
        // swallowed silently (`.catch(() => null)`), which made rate-limit
        // and not-found cases invisible to callers iterating sub-tickets
        // (Stories deciding which Tasks to dispatch, etc.). Warn loudly so
        // the operator and downstream aggregator (epic-runner / epic-execute-record-wave)
        // see the gap; we still return null to preserve the "best-effort"
        // partial-read contract that the orchestrator depends on.
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

export async function getTicket(ctx, ticketId, opts = {}) {
  if (!opts.fresh) {
    if (Number.isFinite(opts.maxAgeMs)) {
      const fresh = ctx.cache.peekFresh(ticketId, opts.maxAgeMs);
      if (fresh !== undefined) return fresh;
    } else if (ctx.cache.has(ticketId)) {
      return ctx.cache.peek(ticketId);
    }
  }

  const issue = await ctx.http.rest(
    `/repos/${ctx.owner}/${ctx.repo}/issues/${ticketId}`,
  );
  const ticket = issueToTicket(issue);
  ctx.cache.set(ticketId, ticket);
  return ticket;
}

export function primeTicketCache(ctx, tickets) {
  ctx.cache.primeMany(tickets);
}

export function invalidateTicket(ctx, ticketId) {
  ctx.cache.invalidate(ticketId);
}

/* node:coverage ignore next */
export async function getTicketDependencies(ctx, ticketId) {
  const ticket = await getTicket(ctx, ticketId);
  return {
    blocks: parseBlocks(ticket.body),
    blockedBy: parseBlockedBy(ticket.body),
  };
}

/* node:coverage ignore next */
export async function createTicket(ctx, parentId, ticketData) {
  const epicId = ticketData.epicId || parentId;
  const renderedBody = composeTaskBody({
    body: ticketData.body ?? '',
    parentId,
    epicId,
    dependencies: ticketData.dependencies ?? [],
    auditSnapshot: ticketData.auditSnapshot,
  });

  const issue = await ctx.http.rest(`/repos/${ctx.owner}/${ctx.repo}/issues`, {
    method: 'POST',
    body: {
      title: ticketData.title,
      body: renderedBody,
      labels: ticketData.labels ?? [],
    },
  });

  let subIssueLinked = false;
  let subIssueError = null;
  try {
    await addSubIssue(ctx, parentId, issue.node_id);
    subIssueLinked = true;
  } catch (err) {
    subIssueError = err;
  }

  try {
    if (ctx.projectNumber) {
      await ctx.hooks.addItemToProject(issue.node_id);
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
 * Establish the native GitHub sub-issue API link between `parentNumber` and
 * the child identified by `childNodeId`. Retries on transient errors (rate
 * limits, secondary RL surfaced as GraphQL-200 + errors[], network blips)
 * with jittered exponential backoff before re-throwing — silent failure here
 * is what produced the text-only orphan tickets that motivated this fix.
 */
export async function addSubIssue(
  ctx,
  parentNumber,
  childNodeId,
  opts = { replaceParent: false },
) {
  const parentTicket = await getTicket(ctx, parentNumber);
  let lastErr;
  for (let attempt = 0; attempt < SUB_ISSUE_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await runGraphql(
        ctx,
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

/**
 * Reconciliation pass: walk every child of `epicId` whose body footer carries
 * `parent: #<n>` and verify the GitHub native sub-issue API link is present.
 * Re-establish missing links via `addSubIssue` (which retries internally on
 * transient errors). Idempotent and safe to re-run on partially-linked Epics
 * — a child whose link already exists is skipped.
 *
 * Returns `{ totalExpected, alreadyLinked, reconciled, failed, failures }`.
 * Caller decides whether `failed > 0` should be fatal.
 */
export async function reconcileSubIssueLinks(ctx, epicId) {
  const PARENT_RE = /(?:^|\n)parent:\s*#(\d+)/;

  const allChildren = await getTickets(ctx, epicId);
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

  // cap=4 — independent per-parent link-reconciliation work; safe to fan out
  // because each parent's child set is disjoint from its siblings'.
  await concurrentMap(
    parentEntries,
    async ([parentId, childIds]) => {
      let parent;
      try {
        parent = await getTicket(ctx, parentId);
      } catch (err) {
        for (const childId of childIds) {
          failures.push({ parentId, childId, reason: err.message });
        }
        failed += childIds.length;
        return;
      }
      if (!parent?.nodeId) {
        for (const childId of childIds) {
          failures.push({ parentId, childId, reason: 'parent missing nodeId' });
        }
        failed += childIds.length;
        return;
      }

      const linked = new Set(
        await getNativeSubIssues(ctx, parent.nodeId, parentId),
      );

      // cap=4 — within a single parent, each child's link work is
      // independent (separate getTicket + addSubIssue mutations).
      await concurrentMap(
        childIds,
        async (childId) => {
          if (linked.has(childId)) {
            alreadyLinked++;
            return;
          }
          let childTicket;
          try {
            childTicket = await getTicket(ctx, childId);
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
            await addSubIssue(ctx, parentId, childTicket.nodeId);
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

export async function removeSubIssue(ctx, parentNumber, subIssueNumber) {
  const parentTicket = await getTicket(ctx, parentNumber);
  const childTicket = await getTicket(ctx, subIssueNumber);
  return runGraphql(
    ctx,
    REMOVE_SUB_ISSUE_MUTATION,
    { parentId: parentTicket.nodeId, subIssueId: childTicket.nodeId },
    { headers: { 'GraphQL-Features': 'sub_issues' } },
  );
}

/**
 * Apply label add/remove mutations to an issue.
 *
 * When the only mutation is "add labels", uses the additive labels-API
 * endpoint for atomicity and to avoid a read-before-write. When other PATCH
 * fields are present, or when removing labels, computes the final label set
 * and returns it to the caller for inclusion in the PATCH.
 */
export async function applyLabelMutations(
  ctx,
  ticketId,
  labels,
  hasOtherPatchFields,
) {
  const { add = [], remove = [] } = labels;

  if (add.length > 0 && remove.length === 0 && !hasOtherPatchFields) {
    await ctx.http.rest(
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ticketId}/labels`,
      { method: 'POST', body: { labels: add } },
    );
    return { skipPatch: true };
  }

  const ticket = await getTicket(ctx, ticketId);
  const currentLabels = new Set(ticket.labels ?? []);
  for (const l of remove) currentLabels.delete(l);
  for (const l of add) currentLabels.add(l);

  return { skipPatch: false, mergedLabels: Array.from(currentLabels) };
}

/* node:coverage ignore next */
export async function updateTicket(ctx, ticketId, mutations) {
  const patch = {};

  if (mutations.body !== undefined) patch.body = mutations.body;
  if (mutations.assignees) patch.assignees = mutations.assignees;
  if (mutations.state !== undefined) patch.state = mutations.state;
  if (mutations.state_reason !== undefined)
    patch.state_reason = mutations.state_reason;

  if (mutations.labels) {
    const hasOtherPatchFields = Object.keys(patch).length > 0;
    const result = await applyLabelMutations(
      ctx,
      ticketId,
      mutations.labels,
      hasOtherPatchFields,
    );
    if (result.skipPatch) return;
    patch.labels = result.mergedLabels;
  }

  if (Object.keys(patch).length > 0) {
    await ctx.http.rest(`/repos/${ctx.owner}/${ctx.repo}/issues/${ticketId}`, {
      method: 'PATCH',
      body: patch,
    });
    invalidateTicket(ctx, ticketId);
  }
}
