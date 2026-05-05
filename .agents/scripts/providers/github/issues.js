/**
 * GitHub Issues — read/write ticket operations.
 *
 * Pure functions over a `ctx` object (`{ owner, repo, http, cache, hooks }`).
 * No imports from sibling submodules under `providers/github/` — cross-cutting
 * concerns (project-add on create, etc.) are threaded in through `ctx.hooks`
 * and wired up by the facade.
 */

import { parseBlockedBy, parseBlocks } from '../../lib/dependency-parser.js';
import { TYPE_LABELS } from '../../lib/label-constants.js';
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
      console.warn(
        `[GitHubProvider] sub-issues GraphQL unavailable (parent #${parentId}); using checklist fallback`,
      );
      return [];
    }
    console.error(
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
    console.warn(
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
    (id) => getTicket(ctx, id).catch(() => null),
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
  const bodyParts = [ticketData.body || '', '', `---`, `parent: #${parentId}`];

  if (epicId !== parentId) {
    bodyParts.push(`Epic: #${epicId}`);
  }

  if (ticketData.dependencies?.length) {
    bodyParts.push('');
    for (const dep of ticketData.dependencies) {
      bodyParts.push(`blocked by #${dep}`);
    }
  }

  const issue = await ctx.http.rest(`/repos/${ctx.owner}/${ctx.repo}/issues`, {
    method: 'POST',
    body: {
      title: ticketData.title,
      body: bodyParts.join('\n'),
      labels: ticketData.labels ?? [],
    },
  });

  try {
    await addSubIssue(ctx, parentId, issue.node_id);
  } catch (err) {
    console.warn(
      `[GitHubProvider] sub-issue link failed for #${issue.number} → parent #${parentId}: ${err.message}`,
    );
  }

  try {
    if (ctx.projectNumber) {
      await ctx.hooks.addItemToProject(issue.node_id);
    }
  } catch (err) {
    console.warn(
      `[GitHubProvider] Failed to add Issue #${issue.number} to project: ${err.message}`,
    );
  }

  return {
    id: issue.number,
    internalId: issue.id,
    nodeId: issue.node_id,
    url: issue.html_url,
  };
}

export async function addSubIssue(
  ctx,
  parentNumber,
  childNodeId,
  opts = { replaceParent: false },
) {
  const parentTicket = await getTicket(ctx, parentNumber);
  return runGraphql(
    ctx,
    ADD_SUB_ISSUE_MUTATION,
    {
      parentId: parentTicket.nodeId,
      subIssueId: childNodeId,
      replaceParent: opts.replaceParent,
    },
    { headers: { 'GraphQL-Features': 'sub_issues' } },
  );
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
