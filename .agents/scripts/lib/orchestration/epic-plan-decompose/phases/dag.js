/**
 * dag.js — Phase 2 of the epic-plan-decompose pipeline (Story #2466).
 *
 * Owns the deterministic DAG helpers used by the creation passes:
 *   - `resolveParentId(ticket, slugMap, epicId)`
 *   - `resolveDependencies(ticket, slugMap)`
 *   - `orderTicketsForCreation(validated)` (topological sort within each
 *     (parent_slug, type) group, concatenated in feature → story → task
 *     order so parents always exist before their children get created)
 *
 * Extracted verbatim from `epic-plan-decompose.js` so the named exports
 * (`resolveDependencies`, `orderTicketsForCreation`) that the
 * `tests/ticket-decomposer.test.js` suite imports keep their contract.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/dag
 */

export function resolveParentId(ticket, slugMap, epicId) {
  if (ticket.type === 'feature') return epicId;
  if (!ticket.parent_slug) {
    throw new Error(
      `[Decomposer] ${ticket.type.toUpperCase()} "${ticket.title}" (${ticket.slug}) has no parent_slug.`,
    );
  }
  if (!slugMap.has(ticket.parent_slug)) {
    throw new Error(
      `[Decomposer] ${ticket.type.toUpperCase()} "${ticket.title}" (${ticket.slug}) references parent_slug "${ticket.parent_slug}" which was not created. The parent is missing from the ticket array or the slug is misspelled.`,
    );
  }
  return slugMap.get(ticket.parent_slug);
}

export function resolveDependencies(ticket, slugMap) {
  const resolved = [];
  for (const dep of ticket.depends_on || []) {
    const depId = slugMap.get(dep);
    if (depId === undefined) {
      // Unreachable through normal flow: validateAndNormalizeTickets
      // already rejects unknown slugs and the topological sort guarantees
      // creation order. A throw here turns a future regression (e.g.
      // someone bypassing the validator) into a loud failure instead of a
      // silently-dropped DAG edge.
      throw new Error(
        `[Decomposer] ${ticket.type.toUpperCase()} "${ticket.title}" (${ticket.slug}) depends on unresolved slug "${dep}". This indicates a planner bug or out-of-order ticket creation.`,
      );
    }
    resolved.push(depId);
  }
  return resolved;
}

function topoSortGroup(group) {
  const slugToTicket = new Map(group.map((t) => [t.slug, t]));
  const visited = new Set();
  const sorted = [];

  function visit(t) {
    if (visited.has(t.slug)) return;
    visited.add(t.slug);
    for (const dep of t.depends_on ?? []) {
      const depTicket = slugToTicket.get(dep);
      if (depTicket) visit(depTicket);
    }
    sorted.push(t);
  }

  for (const t of group) visit(t);
  return sorted;
}

/**
 * Topologically sort tickets within each (parent_slug, type) group, then
 * concatenate groups in typeOrder so parents are always created before
 * children (Feature → Story → Task) and intra-group dep chains resolve
 * before their dependents are created.
 */
export function orderTicketsForCreation(validated) {
  const typeOrder = { feature: 0, story: 1, task: 2 };
  const groups = new Map();
  for (const t of validated) {
    const parentKey = t.parent_slug ?? '__epic__';
    const key = `${t.type}::${parentKey}`;
    if (!groups.has(key)) groups.set(key, { type: t.type, items: [] });
    groups.get(key).items.push(t);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => typeOrder[a.type] - typeOrder[b.type],
  );
  const result = [];
  for (const group of ordered) {
    for (const t of topoSortGroup(group.items)) result.push(t);
  }
  return result;
}
