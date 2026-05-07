/**
 * GitHub ticket-mapper — pure functions that translate raw GitHub API
 * payloads (REST Issue, GraphQL sub-issue node) into the normalized ticket
 * shape consumed throughout the orchestration layer.
 *
 * No I/O, no state. All inputs are plain objects as returned by
 * `providers/github/http-client.js`; outputs are the exact shape previously
 * produced by `GitHubProvider.getTicket` / `_subIssueNodeToTicket`.
 */

import { parseLinkedIssues } from '../../lib/issue-link-parser.js';

/**
 * Flatten the label collection on an issue/node into an array of label names.
 * Handles both shapes the GitHub API returns:
 *   - REST: `issue.labels` is an array of strings or `{ name }` objects.
 *   - GraphQL: `issue.labels.nodes` is an array of `{ name }` objects.
 * Returns `[]` when labels are missing/null.
 */
export function normalizeLabels(issue) {
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

/**
 * Map a REST Issue payload into the ticket shape used by `getTicket`.
 */
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

/**
 * Map a REST Issue payload into the Epic shape (adds `linkedIssues`).
 */
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

/**
 * Map a GraphQL sub-issue node into the ticket shape that
 * `getTicket`/`getTickets` return. Keeps the state label lower-cased to match
 * the REST API (`open`/`closed`) so downstream code never has to case-
 * normalise at the call site.
 */
export function subIssueNodeToTicket(node) {
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
 * Map a REST Issue plus list-scoped filters into the reduced shape used by
 * `listIssues` / `getEpics` / `getTickets`.
 */
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

/**
 * Map a REST Issue for Epic-list results (no body/nodeId needed — preserves
 * the historical shape of `_getEpics`).
 */
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
