/**
 * GitHub Provider — pure REST/GraphQL ticket mappers.
 *
 * Pure functions that translate raw GitHub API payloads (REST `Issue`,
 * GraphQL sub-issue node) into the normalized ticket shape consumed
 * throughout the dispatcher / reconciler layer. No I/O, no state, no
 * `execSync` —
 * verified by the sibling test which exercises the mappers without `gh`
 * installed.
 *
 * Extracted from `../github.js` in Story #1846 / Task #1859.
 */

import { parseLinkedIssues } from '../../lib/issue-link-parser.js';

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

export function issueToTicket(issue) {
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

export function issueToEpic(issue) {
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

export function subIssueNodeToTicket(node) {
  // Story #3097 (Wave-0 additive, Epic #3078 Strategy B) — return `null`
  // for absent sub-issue nodes instead of dereferencing properties on
  // `null`/`undefined`. In 2-tier mode a Story can legitimately have zero
  // Task children, which surfaces as an empty / missing sub-issue node
  // when callers iterate the GraphQL response and pass each entry through
  // this mapper. The legacy 4-tier path also benefits — a transient
  // empty node returned mid-pagination no longer throws.
  if (node == null) return null;
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

/**
 * Map a list of raw GraphQL sub-issue nodes to ticket objects, skipping
 * any null/undefined entries. Story #3097 (Wave-0 additive, Epic #3078
 * Strategy B) — gives callers a single Storyless-tolerant entry point so
 * the existing per-node mappers can stay strict for the 4-tier path while
 * the 2-tier path (Storyless: a Story with zero child Tasks) gets a
 * well-defined empty-array result.
 *
 * @param {Array<object|null|undefined>|null|undefined} nodes
 * @returns {object[]}
 */
export function subIssueNodesToTickets(nodes) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const node of nodes) {
    const mapped = subIssueNodeToTicket(node);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

export function issueToListItem(issue) {
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

export function issueToEpicListItem(issue) {
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
