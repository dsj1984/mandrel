import { assignLayers, computeReachability, detectCycle } from '../Graph.js';

export { autoSerializeOverlaps } from './concurrent-task-resolver.js';

/**
 * Roll focus-area sets up from tasks to stories. Returns a map of
 * storyId → { areas: Set<string>, global: boolean }. A story is "global"
 * if any of its tasks declares `scope === 'root'` or a `*` focus area —
 * meaning it is treated as overlapping every other story.
 *
 * Stories with no task-level focusAreas declared produce an empty set and
 * are excluded from overlap serialization (no false positives).
 *
 * @param {Map<number|string, {tasks: object[]}>} storyGroups
 * @returns {Map<number|string, {areas: Set<string>, global: boolean}>}
 */
function rollUpStoryFocus(storyGroups) {
  const storyFocus = new Map();
  for (const [storyId, group] of storyGroups.entries()) {
    const areas = new Set();
    let global = false;
    for (const task of group.tasks ?? []) {
      if (task.scope === 'root') global = true;
      if (Array.isArray(task.focusAreas)) {
        for (const area of task.focusAreas) {
          if (area === '*') global = true;
          else areas.add(area);
        }
      }
    }
    storyFocus.set(storyId, { areas, global });
  }
  return storyFocus;
}

/**
 * Add focus-area overlap edges to a story-level adjacency map.
 *
 * Two stories overlap when any task in story A and any task in story B share
 * a `focusAreas` entry (or either story is "global" via scope::root / `*`).
 * For overlapping pairs that are not already ordered by an existing edge,
 * we insert an edge from the lower storyId to the higher storyId — this is
 * deterministic and avoids cycles with existing edges because we only add
 * when *neither* direction is reachable.
 *
 * Stories with no declared focus areas are skipped to prevent over-
 * serialization when planning data is incomplete.
 *
 * Mutates `adjacency` in place. Returns the count of edges added.
 *
 * @param {Map<number|string, number[]>} adjacency
 * @param {Map<number|string, {tasks: object[]}>} storyGroups
 * @returns {number}
 */
/**
 * Predicate: would adding a focus-overlap edge between stories `a` and
 * `b` be both semantically correct (they overlap) and graph-safe (neither
 * direction is already reachable)? Returns `true` when the caller should
 * insert an edge, `false` when the pair should be skipped.
 *
 * Extracted from `addFocusOverlapEdges` so the per-pair guard cascade
 * (missing focus, both-empty-non-global, no overlap, reachability collision)
 * is straight-line and independently testable; the parent loop body
 * collapses to "decide direction + push if not already present" once the
 * predicate has cleared.
 *
 * @param {object} args
 * @param {{areas: Set<string>, global: boolean}|undefined} args.focusA
 *   Rolled-up focus bag for story `a`.
 * @param {{areas: Set<string>, global: boolean}|undefined} args.focusB
 *   Rolled-up focus bag for story `b`.
 * @param {Map<number|string, Set<number|string>>} args.reachable
 *   Transitive-reach map from `computeReachability(adjacency)`.
 * @param {number|string} args.a
 * @param {number|string} args.b
 * @returns {boolean}
 */
export function isFocusOverlapEdgeEligible({ focusA, focusB, reachable, a, b }) {
  if (!hasUsableFocus(focusA)) return false;
  if (!hasUsableFocus(focusB)) return false;
  if (!focusBagsOverlap(focusA, focusB)) return false;
  if (eitherDirectionAlreadyReachable(reachable, a, b)) return false;
  return true;
}

/**
 * Predicate: does the focus bag actually carry usable focus signal? A
 * bag with no declared areas and not flagged global is treated as
 * "unknown" and skipped by the overlap predicate — the caller deliberately
 * over-serializes only when at least one side declares scope.
 *
 * @param {{areas: Set<string>, global: boolean}|undefined} focus
 * @returns {boolean}
 */
function hasUsableFocus(focus) {
  if (!focus) return false;
  if (focus.global) return true;
  return focus.areas.size > 0;
}

/**
 * Predicate: do two rolled-up focus bags overlap? Either side being
 * global implies overlap; otherwise we test set intersection.
 *
 * @param {{areas: Set<string>, global: boolean}} focusA
 * @param {{areas: Set<string>, global: boolean}} focusB
 * @returns {boolean}
 */
function focusBagsOverlap(focusA, focusB) {
  if (focusA.global || focusB.global) return true;
  for (const area of focusA.areas) {
    if (focusB.areas.has(area)) return true;
  }
  return false;
}

/**
 * Predicate: is either direction `a → b` or `b → a` already reachable in
 * the existing adjacency closure? When yes, adding a new overlap edge
 * would either be redundant or risk a cycle, so the caller skips.
 *
 * @param {Map<number|string, Set<number|string>>} reachable
 * @param {number|string} a
 * @param {number|string} b
 * @returns {boolean}
 */
function eitherDirectionAlreadyReachable(reachable, a, b) {
  if (reachable.get(a)?.has(b)) return true;
  if (reachable.get(b)?.has(a)) return true;
  return false;
}

/**
 * Pick the deterministic edge direction for a focus-overlap pair: lower
 * id runs first. Numeric ids sort numerically; string ids (rare — only
 * `__ungrouped__`, already filtered upstream) fall back to lexicographic.
 *
 * @param {number|string} a
 * @param {number|string} b
 * @returns {[from: number|string, to: number|string]}
 */
function pickEdgeDirection(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? [a, b] : [b, a];
  }
  return String(a) < String(b) ? [a, b] : [b, a];
}

function addFocusOverlapEdges(adjacency, storyGroups) {
  const storyFocus = rollUpStoryFocus(storyGroups);
  const reachable = computeReachability(adjacency);
  const storyIds = [...storyGroups.keys()].filter(
    (id) => id !== '__ungrouped__',
  );
  let added = 0;

  for (let i = 0; i < storyIds.length; i++) {
    for (let j = i + 1; j < storyIds.length; j++) {
      const a = storyIds[i];
      const b = storyIds[j];
      const eligible = isFocusOverlapEdgeEligible({
        focusA: storyFocus.get(a),
        focusB: storyFocus.get(b),
        reachable,
        a,
        b,
      });
      if (!eligible) continue;

      const [from, to] = pickEdgeDirection(a, b);
      const deps = adjacency.get(to) ?? [];
      if (!deps.includes(from)) {
        deps.push(from);
        adjacency.set(to, deps);
        added++;
      }
    }
  }

  return added;
}

/**
 * Compute story-level execution waves from cross-story task dependencies,
 * explicit story-to-story `blocked by` declarations, AND focus-area overlap
 * between stories within the same Epic.
 *
 * Sources of story dependencies:
 *   1. **Implicit (cross-story tasks)**: Task T in Story A depends on Task T'
 *      in Story B → Story A depends on Story B.
 *   2. **Explicit (story body)**: Story A body contains `blocked by #B` →
 *      Story A depends on Story B.
 *   3. **Focus overlap (file contention)**: Stories A and B share any
 *      `focusAreas` entry (rolled up from child tasks), or one is globally
 *      scoped. The lower storyId is placed ahead of the higher to serialize
 *      the pair — this prevents the "five parallel stories all writing to
 *      the same directory" contention that cannot be solved at runtime when
 *      agents share a working tree. Stories with no declared focus areas
 *      are left alone to avoid over-serialization.
 *
 * After merging all three sources, runs `assignLayers` to produce wave
 * indices.
 *
 * @param {Map<number, {storyId: number|string, tasks: object[]}>} storyGroups
 *   Map of storyId → { storyId, tasks: [{ id, dependsOn, focusAreas?, scope? }] }
 * @param {Map<number|string, number[]>} [explicitDeps]
 *   Optional map of storyId → [blockerStoryId, ...] parsed from story ticket
 *   `blocked by` references. Only includes references to *other stories within
 *   the same Epic*.
 * @returns {Map<number|string, number>} Map of storyId → wave index.
 */
export function computeStoryWaves(storyGroups, explicitDeps) {
  // Build a reverse lookup: taskId → storyId
  const taskToStory = new Map();
  for (const [storyId, group] of storyGroups.entries()) {
    for (const task of group.tasks) {
      taskToStory.set(task.id, storyId);
    }
  }

  // Build story-level adjacency: storyA depends on storyB if any task in
  // storyA has a dependency on a task in storyB.
  const storyAdjacency = new Map();
  for (const storyId of storyGroups.keys()) {
    storyAdjacency.set(storyId, []);
  }

  for (const [storyId, group] of storyGroups.entries()) {
    const depStories = new Set();
    for (const task of group.tasks) {
      for (const depId of task.dependsOn ?? []) {
        const depStory = taskToStory.get(depId);
        if (depStory !== undefined && depStory !== storyId) {
          depStories.add(depStory);
        }
      }
    }

    // Merge explicit story-to-story dependencies (from `blocked by` on the
    // story ticket body itself).
    if (explicitDeps) {
      const explicit = explicitDeps.get(storyId) ?? [];
      for (const depStoryId of explicit) {
        if (depStoryId !== storyId && storyGroups.has(depStoryId)) {
          depStories.add(depStoryId);
        }
      }
    }

    storyAdjacency.set(storyId, [...depStories]);
  }

  // Detect cycles in the dependency-derived graph BEFORE adding focus-overlap
  // edges. Pre-existing cycles are a planning error; overlap edges are only
  // added when neither direction is already reachable so they cannot
  // introduce a new cycle.
  const cycle = detectCycle(storyAdjacency);
  if (cycle) {
    throw new Error(
      `[Graph] Story-level dependency cycle detected: ${cycle.join(' → ')}. ` +
        'This usually means cross-story task dependencies form a circular chain.',
    );
  }

  addFocusOverlapEdges(storyAdjacency, storyGroups);

  // Assign layers (waves) to stories
  return assignLayers(storyAdjacency);
}

// Exported for targeted unit testing; not part of the stable module API.
export const __test = { rollUpStoryFocus, addFocusOverlapEdges };
