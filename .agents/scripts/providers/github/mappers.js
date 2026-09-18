/**
 * GitHub Provider — pure mappers from REST issues / GraphQL sub-issue nodes
 * to the normalized ticket shape.
 */

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
    // Distinguishes a landed Story from a superseded one; both are `closed`.
    stateReason: issue.state_reason ?? null,
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
  };
}

export function subIssueNodeToTicket(node) {
  // Absent nodes are legitimate (childless Story, empty page entry).
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
 * Skips null entries; a non-array yields `[]`.
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
