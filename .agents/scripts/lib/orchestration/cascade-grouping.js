/**
 * lib/orchestration/cascade-grouping.js — Cascade dispatch helpers.
 *
 * Pure helpers used by `cascadeCompletion` (see `./ticketing.js`) to
 * partition a list of parent tickets into disjoint shared-ancestor groups
 * and to buffer per-parent log output so parallel dispatch produces a
 * byte-identical log stream to the serial baseline.
 *
 * Pulled out of `ticketing.js` so the cascade orchestrator stays under the
 * project's per-file maintainability ceiling. No state is held at module
 * scope — every helper takes its dependencies as arguments.
 */

/**
 * Walks `parent: #N` references upward from the given ticket id until no new
 * ancestors are discovered. Returns the set of every ticket id reachable
 * along the chain, including the starting id. Cycle-safe by construction —
 * the visited set acts as the seen guard, so a cyclic `parent: #N` graph
 * terminates in finite steps without revisiting nodes.
 *
 * Pure of side effects beyond the provider reads it issues. Provider
 * failures on a single hop fall back to "no further ancestors discovered"
 * for that branch (the chain truncates rather than throwing); this matches
 * `cascadeCompletion`'s tolerant posture toward transient reads.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} startId
 * @param {Map<number, Set<number>>} [cache] - Optional per-call cache of
 *   already-walked chains keyed by intermediate id. Reused across parents
 *   in {@link groupByAncestor} to amortise repeat walks.
 * @returns {Promise<Set<number>>} ancestor set including `startId`.
 */
export async function walkAncestorChain(provider, startId, cache) {
  // Inner DFS with memoisation. `inProgress` guards cycles so a cyclic
  // `parent: #N` graph terminates without recursion depth issues. Each
  // visited node gets its own cache entry holding the set of ids reachable
  // from it (inclusive), so a sibling walk that re-enters this subgraph
  // can splice the cached set wholesale instead of re-reading the provider.
  async function visit(id, inProgress) {
    if (cache?.has(id)) return cache.get(id);
    if (inProgress.has(id)) {
      // Cycle: return a singleton so the caller still includes `id` in its
      // ancestor set without recursing further through this loop. Do NOT
      // memoise — the partial result is incomplete for `id`'s true chain.
      return new Set([id]);
    }
    inProgress.add(id);

    const set = new Set([id]);
    let ticket = null;
    try {
      ticket = await provider.getTicket(id);
    } catch {
      // Provider read failure: truncate the chain branch. Memoise as the
      // singleton so subsequent walks don't retry an already-failed read.
      inProgress.delete(id);
      cache?.set(id, set);
      return set;
    }

    if (ticket?.body) {
      const matches = [...ticket.body.matchAll(/parent:\s*#(\d+)/gi)];
      for (const m of matches) {
        const next = Number.parseInt(m[1], 10);
        if (!Number.isFinite(next)) continue;
        const subset = await visit(next, inProgress);
        for (const v of subset) set.add(v);
      }
    }

    inProgress.delete(id);
    cache?.set(id, set);
    return set;
  }

  return visit(startId, new Set());
}

/**
 * Partitions a list of parent ids into disjoint groups whose members share
 * at least one ancestor (transitively, via `parent: #N` references walked
 * to fixpoint).
 *
 * Two parents end up in the same group if and only if their ancestor sets
 * overlap on at least one ticket id. Parents with no shared ancestors end
 * up in singleton groups. The union of the returned groups equals the
 * input set; the order of `parents[]` is preserved within each group, and
 * groups are returned in the order their first member appears in the
 * input.
 *
 * Pure of side effects beyond the provider reads needed to walk chains.
 * Walked ancestor sets are cached per call so a parent that contributes
 * to multiple groups is not re-walked. Cycle-safe — see
 * {@link walkAncestorChain}.
 *
 * Used by `cascadeCompletion` to dispatch disjoint groups in parallel
 * while keeping shared-ancestor groups strictly sequential (concurrent
 * transitions on the same ancestor would race the "all children done?"
 * check).
 *
 * @param {Array<number>} parents
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @returns {Promise<Array<Array<number>>>} disjoint groups of parent ids.
 */
export async function groupByAncestor(parents, provider) {
  if (!Array.isArray(parents) || parents.length === 0) return [];

  // Walk each parent's ancestor chain once, sharing a cache so a parent
  // that re-enters an already-walked subgraph reuses the cached set.
  const cache = new Map();
  const ancestorsByParent = new Map();
  for (const parentId of parents) {
    const chain = await walkAncestorChain(provider, parentId, cache);
    ancestorsByParent.set(parentId, chain);
  }

  return unionFindByAncestor(parents, ancestorsByParent);
}

/**
 * Union-Find over `parents`, joined whenever any two parents' ancestor
 * chains overlap on at least one id. Returns the parents bucketed by
 * representative, in input order both for the groups themselves and for
 * members within each group.
 *
 * Pulled out of {@link groupByAncestor} to keep that function's CRAP
 * under the v6 ceiling.
 *
 * @param {Array<number>} parents
 * @param {Map<number, Set<number>>} ancestorsByParent
 * @returns {Array<Array<number>>}
 */
function unionFindByAncestor(parents, ancestorsByParent) {
  const parentIndex = new Map();
  parents.forEach((p, i) => {
    parentIndex.set(p, i);
  });
  const uf = parents.map((_, i) => i);
  const find = (i) => {
    while (uf[i] !== i) {
      uf[i] = uf[uf[i]];
      i = uf[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) uf[ra] = rb;
  };

  // For each ancestor id, collect parents whose chain hits it; union them.
  const ancestorToParents = new Map();
  for (const [parentId, chain] of ancestorsByParent) {
    for (const ancestorId of chain) {
      if (!ancestorToParents.has(ancestorId)) {
        ancestorToParents.set(ancestorId, []);
      }
      ancestorToParents.get(ancestorId).push(parentId);
    }
  }
  for (const sharing of ancestorToParents.values()) {
    if (sharing.length < 2) continue;
    const first = parentIndex.get(sharing[0]);
    for (let i = 1; i < sharing.length; i++) {
      union(first, parentIndex.get(sharing[i]));
    }
  }

  // Bucket parents by representative, preserving first-seen order for
  // both groups and within-group ordering.
  const repToGroup = new Map();
  const groupOrder = [];
  for (const parentId of parents) {
    const rep = find(parentIndex.get(parentId));
    if (!repToGroup.has(rep)) {
      repToGroup.set(rep, []);
      groupOrder.push(rep);
    }
    repToGroup.get(rep).push(parentId);
  }

  return groupOrder.map((rep) => repToGroup.get(rep));
}

/**
 * Dispatches cascade work across disjoint shared-ancestor groups in
 * parallel while running each within-group parent sequentially in input
 * order. Per-parent output is captured into a buffered logger so the
 * visible log stream is byte-identical to a serial baseline; the buffer
 * is flushed to `flushLogger` in the original `parsedParents` order
 * after every group resolves.
 *
 * The actual per-parent work is supplied by `processParent` so this
 * helper stays free of cascade-specific dependencies — its only job is
 * the parallel-dispatch + ordered-flush scaffolding.
 *
 * @template R
 * @param {Object} args
 * @param {Array<number>} args.parsedParents - Parent ids in their
 *   original input order. Drives both the group-membership lookup and
 *   the post-dispatch log flush order.
 * @param {Array<Array<number>>} args.groups - Disjoint groups returned
 *   by {@link groupByAncestor}.
 * @param {(parentId: number, bufferedLogger: object) => Promise<R>} args.processParent
 *   Per-parent worker. Receives the parent id and a buffered logger.
 *   Its resolved value is collected into `args.parsedParents`-ordered
 *   results.
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} args.flushLogger
 *   Real logger that receives the buffered output after dispatch.
 * @returns {Promise<Array<R>>} per-parent results in `parsedParents`
 *   order.
 */
export async function dispatchCascadeGroups({
  parsedParents,
  groups,
  processParent,
  flushLogger,
}) {
  const parentLoggers = new Map();
  const parentResults = new Map();
  for (const parentId of parsedParents) {
    parentLoggers.set(parentId, createBufferedLogger());
  }

  await Promise.all(
    groups.map(async (group) => {
      for (const parentId of group) {
        const logger = parentLoggers.get(parentId);
        const result = await processParent(parentId, logger);
        parentResults.set(parentId, result);
      }
    }),
  );

  const results = [];
  for (const parentId of parsedParents) {
    const lg = parentLoggers.get(parentId);
    if (lg) {
      for (const entry of lg.buffer) {
        flushLogger[entry.level](entry.message);
      }
    }
    const result = parentResults.get(parentId);
    if (result !== undefined) results.push(result);
  }
  return results;
}

/**
 * Buffered logger shaped like the public `Logger` surface. Stores every
 * emitted line in `buffer[]` instead of writing to the console. Callers
 * flush the buffer to a real logger after the buffered region completes
 * so the visible log output is byte-identical to a serial run.
 *
 * @returns {{ buffer: Array<{ level: 'debug'|'info'|'warn'|'error', message: string }>, debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createBufferedLogger() {
  const buffer = [];
  return {
    buffer,
    debug(message) {
      buffer.push({ level: 'debug', message });
    },
    info(message) {
      buffer.push({ level: 'info', message });
    },
    warn(message) {
      buffer.push({ level: 'warn', message });
    },
    error(message) {
      buffer.push({ level: 'error', message });
    },
  };
}
