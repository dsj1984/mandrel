/**
 * dag.js — Phase 2 of the epic-plan-decompose pipeline (Story #2466).
 *
 * Owns the deterministic DAG helpers used by the reconciler pipeline:
 *   - `resolveDependencies(ticket, slugMap)`
 *   - `orderTicketsForCreation(validated)` (topological sort of the
 *     Story set so dependency producers are created before consumers)
 *
 * Extracted verbatim from `epic-plan-decompose.js` so the named exports
 * (`resolveDependencies`, `orderTicketsForCreation`) that the
 * `tests/ticket-decomposer.test.js` suite imports keep their contract.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/dag
 */

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
 * Topologically sort the Story set so intra-set dep chains resolve
 * before their dependents are created. The 2-tier hierarchy has a
 * single ticket type (story) attached directly to the Epic, so there
 * is no parent-type ordering to interleave.
 */
export function orderTicketsForCreation(validated) {
  const result = [];
  for (const t of topoSortGroup([...validated])) result.push(t);
  return result;
}
