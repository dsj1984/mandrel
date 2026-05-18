/**
 * Graph.js
 * Extracted mathematical DAG logic for topological sorting, cycle detection,
 * transitive reduction, and auto-serialization of concurrent task overlaps.
 */

/**
 * Builds an adjacency list from the manifest tasks.
 * Returns { adjacency: Map<id, id[]>, taskMap: Map<id, task> }
 */
export function buildGraph(tasks) {
  const adjacency = new Map();
  const taskMap = new Map();

  for (const task of tasks) {
    adjacency.set(task.id, [...task.dependsOn]);
    taskMap.set(task.id, task);
  }

  return { adjacency, taskMap };
}

/**
 * Detects cycles using DFS. Returns the first cycle found as an array of ids,
 * or null if the graph is acyclic.
 */
export function detectCycle(adjacency) {
  const WHITE = 0,
    _GRAY = 1,
    _BLACK = 2;
  const color = new Map();
  const parent = new Map();

  for (const id of adjacency.keys()) {
    color.set(id, WHITE);
  }

  for (const id of adjacency.keys()) {
    if (color.get(id) === WHITE) {
      const cycle = dfsVisit(id, adjacency, color, parent);
      if (cycle) return cycle;
    }
  }

  return null;
}

function dfsVisit(u, adjacency, color, parent) {
  color.set(u, 1); // GRAY

  for (const v of adjacency.get(u) || []) {
    if (color.get(v) === 1) {
      // Back edge → cycle. Reconstruct.
      const cycle = [v, u];
      let cur = u;
      while (parent.has(cur) && parent.get(cur) !== v) {
        cur = parent.get(cur);
        cycle.push(cur);
      }
      return cycle.reverse();
    }
    if (color.get(v) === 0) {
      parent.set(v, u);
      const cycle = dfsVisit(v, adjacency, color, parent);
      if (cycle) return cycle;
    }
  }

  color.set(u, 2); // BLACK
  return null;
}

/**
 * Assigns each task a layer (depth from root). Root tasks (no dependencies)
 * are layer 0. Returns Map<id, layer>.
 */
export function assignLayers(adjacency) {
  const layers = new Map();
  const memo = new Map();

  function getLayer(id) {
    if (memo.has(id)) return memo.get(id);

    const deps = adjacency.get(id) || [];
    if (deps.length === 0) {
      memo.set(id, 0);
      return 0;
    }

    const maxDepLayer = Math.max(...deps.map(getLayer));
    const layer = maxDepLayer + 1;
    memo.set(id, layer);
    return layer;
  }

  for (const id of adjacency.keys()) {
    layers.set(id, getLayer(id));
  }

  return layers;
}

/**
 * Performs transitive reduction on a DAG.
 *
 * Removes edge (u→v) iff some *other* direct dependency w of u satisfies
 * v ∈ reach(w) — i.e. v is reachable from u via a path of length > 1 that
 * does not use the edge (u→v) itself.
 *
 * Two-arg form (preferred on hot paths): callers that already hold a
 * reachability matrix for the same `adjacency` (e.g. the dispatch
 * pipeline, which also feeds it to `autoSerializeOverlaps`) pass it in
 * via `reachable` so we skip the O(V·(V+E)) re-derivation. The per-edge
 * check is then O(1) (`reach(w).has(v)`), making the overall reduction
 * O(V+E) on top of the (amortized) cost of producing `reachable` once.
 *
 * Single-arg form (back-compat): when `reachable` is omitted we compute
 * it locally via `computeReachability(adjacency)` so the function stays
 * a drop-in replacement for the historical single-argument signature.
 * Output is byte-identical between the two forms.
 *
 * @param {Map<*, *[]>} adjacency  Dependency map (node → deps[]).
 * @param {Map<*, Set<*>>} [reachable]  Optional pre-computed reachability
 *   matrix matching `adjacency`. When supplied it MUST cover every node
 *   in `adjacency` — passing a partial map will silently corrupt output.
 * @returns {Map<*, *[]>}  Reduced adjacency map.
 */
export function transitiveReduction(adjacency, reachable) {
  const reach = reachable ?? computeReachability(adjacency);
  const result = new Map();

  for (const [node, deps] of adjacency.entries()) {
    // Early-return: nodes with zero or one dependency cannot have redundant edges
    if (deps.length <= 1) {
      result.set(node, [...deps]);
      continue;
    }

    const kept = [];
    for (const dep of deps) {
      // Edge (node → dep) is redundant iff some other direct dep `other`
      // of `node` already reaches `dep` transitively.
      let isRedundant = false;
      for (const other of deps) {
        if (other === dep) continue;
        if (reach.get(other)?.has(dep)) {
          isRedundant = true;
          break;
        }
      }
      if (!isRedundant) kept.push(dep);
    }
    result.set(node, kept);
  }

  return result;
}

/**
 * Computes which Chat Sessions each Chat Session depends on.
 * Returns a Map<chatNumber, chatNumber[]>.
 */
export function computeChatDependencies(chatSessions, _adjacency) {
  // Build a reverse lookup: taskId → chatNumber
  const taskToChat = new Map();
  for (const session of chatSessions) {
    for (const task of session.tasks) {
      taskToChat.set(task.id, session.chatNumber);
    }
  }

  const chatDeps = new Map();
  for (const session of chatSessions) {
    const deps = new Set();
    for (const task of session.tasks) {
      for (const depId of task.dependsOn) {
        const depChat = taskToChat.get(depId);
        if (depChat !== undefined && depChat !== session.chatNumber) {
          deps.add(depChat);
        }
      }
    }
    chatDeps.set(
      session.chatNumber,
      [...deps].sort((a, b) => a - b),
    );
  }

  // Apply transitive reduction to chat-level dependencies
  return transitiveReduction(chatDeps);
}

/**
 * Computes the transitive closure (reachability matrix) for the DAG.
 * Returns a Map<id, Set<id>> where each key maps to a set of all tasks it can reach.
 */
export function computeReachability(adjacency) {
  // Memoized DFS: each node's reachable set is computed once and cached.
  // Complexity: O(V·(V+E)) — avoids the O(N³) Floyd-Warshall triple loop.
  const memo = new Map();

  function reach(id) {
    if (memo.has(id)) return memo.get(id);
    // Seed with a placeholder to handle cycles defensively
    const set = new Set();
    memo.set(id, set);
    for (const neighbour of adjacency.get(id) || []) {
      set.add(neighbour);
      for (const transitive of reach(neighbour)) {
        set.add(transitive);
      }
    }
    return set;
  }

  const reachable = new Map();
  for (const id of adjacency.keys()) {
    reachable.set(id, reach(id));
  }
  return reachable;
}

/**
 * Performs a topological sort on the DAG using Kahn's algorithm.
 * Returns tasks ordered such that all dependencies precede their dependents.
 * Deterministic: ties are broken by task ID (ascending) for stable output.
 *
 * @param {Map<number, number[]>} adjacency - Dependency map (id → blockedBy[]).
 * @param {Map<number, object>} taskMap - Full task objects keyed by id.
 * @returns {object[]} Tasks in topological order.
 * @throws {Error} If a cycle is detected (should be caught before calling this).
 */
export function topologicalSort(adjacency, taskMap) {
  // Pre-compute reverse adjacency and in-degree for O(V+E)
  const inDegree = new Map();
  const reverseAdj = new Map();

  for (const id of adjacency.keys()) {
    reverseAdj.set(id, []);
  }

  for (const [nodeId, deps] of adjacency.entries()) {
    let activeDeps = 0;
    for (const dep of deps) {
      if (reverseAdj.has(dep)) {
        activeDeps++;
        reverseAdj.get(dep).push(nodeId);
      }
    }
    inDegree.set(nodeId, activeDeps);
  }

  // Seed queue with zero-in-degree nodes (tasks with no active dependencies), sorted by id for determinism
  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id)
    .sort((a, b) => a - b);

  const sorted = [];

  while (queue.length > 0) {
    // Take smallest ID for determinism (queue is kept sorted)
    const id = queue.shift();
    sorted.push(taskMap.get(id));

    // Decrement in-degree for dependents using pre-computed reverse map
    for (const dependent of reverseAdj.get(id) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        // Binary insertion to maintain sorted order — O(log N) per insert
        // instead of re-sorting the entire queue each iteration.
        let lo = 0,
          hi = queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (queue[mid] < dependent) lo = mid + 1;
          else hi = mid;
        }
        queue.splice(lo, 0, dependent);
      }
    }
  }

  if (sorted.length !== adjacency.size) {
    throw new Error(
      '[Graph] topologicalSort detected a cycle. Run detectCycle() first.',
    );
  }

  return sorted;
}

/**
 * Groups tasks into sequential execution waves.
 *
 * A wave contains all tasks whose dependencies are fully satisfied by
 * previously completed waves. Tasks within the same wave can run concurrently
 * (subject to focus-area serialization in the Dispatcher).
 *
 * Uses `assignLayers` to compute depth, then groups by layer value.
 * The returned array is sorted by wave index (wave 0 = roots).
 *
 * @param {Map<number, number[]>} adjacency - Dependency map (id → blockedBy[]).
 * @param {Map<number, object>} taskMap - Full task objects keyed by id.
 * @returns {object[][]} Array of waves, each wave is an array of task objects.
 */
export function computeWaves(adjacency, taskMap) {
  const layers = assignLayers(adjacency);
  const waveMap = new Map(); // layer → task[]

  for (const [id, layer] of layers.entries()) {
    if (!waveMap.has(layer)) waveMap.set(layer, []);
    waveMap.get(layer).push(taskMap.get(id));
  }

  // Sort waves by layer, sort tasks within each wave by id for determinism
  const maxLayer = Math.max(...waveMap.keys());
  const waves = [];
  for (let i = 0; i <= maxLayer; i++) {
    const waveTasks = (waveMap.get(i) ?? []).sort((a, b) => a.id - b.id);
    if (waveTasks.length > 0) waves.push(waveTasks);
  }

  return waves;
}
