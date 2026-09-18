/** DAG utilities: cycle detection, layering, reduction, topological sort. */

/** Returns { adjacency: Map<id, id[]>, taskMap: Map<id, task> }. */
export function buildGraph(tasks) {
  const adjacency = new Map();
  const taskMap = new Map();

  for (const task of tasks) {
    adjacency.set(task.id, [...task.dependsOn]);
    taskMap.set(task.id, task);
  }

  return { adjacency, taskMap };
}

/** The first cycle found as an array of ids, or null. */
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
      // Back edge: reconstruct the cycle.
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

/** Depth from root (roots are layer 0) as Map<id, layer>. */
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
 * Remove edge (u→v) iff another direct dependency of u already reaches v.
 *
 * @param {Map<*, *[]>} adjacency node → deps[].
 * @param {Map<*, Set<*>>} [reachable] Precomputed reachability; when given it
 *   MUST cover every node, or output is silently corrupt.
 * @returns {Map<*, *[]>}
 */
export function transitiveReduction(adjacency, reachable) {
  const reach = reachable ?? computeReachability(adjacency);
  const result = new Map();

  for (const [node, deps] of adjacency.entries()) {
    if (deps.length <= 1) {
      result.set(node, [...deps]);
      continue;
    }

    const kept = [];
    for (const dep of deps) {
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

/** Returns a transitively reduced Map<chatNumber, chatNumber[]>. */
export function computeChatDependencies(chatSessions, _adjacency) {
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

  return transitiveReduction(chatDeps);
}

/** Transitive closure as Map<id, Set<id>>, by memoized DFS: O(V·(V+E)). */
export function computeReachability(adjacency) {
  const memo = new Map();

  function reach(id) {
    if (memo.has(id)) return memo.get(id);
    // Placeholder first, so a cycle cannot recurse forever.
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
 * Kahn's algorithm; ties break by ascending id for stable output.
 *
 * @param {Map<number, number[]>} adjacency id → blockedBy[].
 * @param {Map<number, object>} taskMap
 * @returns {object[]}
 * @throws {Error} On a cycle (run `detectCycle` first).
 */
export function topologicalSort(adjacency, taskMap) {
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

  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id)
    .sort((a, b) => a - b);

  const sorted = [];

  while (queue.length > 0) {
    // The queue is kept sorted, so this is the smallest id.
    const id = queue.shift();
    sorted.push(taskMap.get(id));

    for (const dependent of reverseAdj.get(id) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        // Binary insertion keeps the queue sorted without a re-sort.
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
 * Group tasks by layer; each wave's dependencies are all in earlier waves.
 *
 * @param {Map<number, number[]>} adjacency id → blockedBy[].
 * @param {Map<number, object>} taskMap
 * @returns {object[][]}
 */
export function computeWaves(adjacency, taskMap) {
  const layers = assignLayers(adjacency);
  const waveMap = new Map(); // layer → task[]

  for (const [id, layer] of layers.entries()) {
    if (!waveMap.has(layer)) waveMap.set(layer, []);
    waveMap.get(layer).push(taskMap.get(id));
  }

  const maxLayer = Math.max(...waveMap.keys());
  const waves = [];
  for (let i = 0; i <= maxLayer; i++) {
    const waveTasks = (waveMap.get(i) ?? []).sort((a, b) => a.id - b.id);
    if (waveTasks.length > 0) waves.push(waveTasks);
  }

  return waves;
}
