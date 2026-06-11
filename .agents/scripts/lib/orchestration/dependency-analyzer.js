import { assignLayers, detectCycle } from '../Graph.js';

/**
 * Compute story-level execution waves from cross-story task dependencies AND
 * explicit story-to-story `blocked by` declarations within the same Epic.
 *
 * Sources of story dependencies:
 *   1. **Implicit (cross-story tasks)**: Task T in Story A depends on Task T'
 *      in Story B → Story A depends on Story B. Under the 2-tier hierarchy
 *      (Epic → Story) Stories carry no child Tasks, so this source
 *      is empty in practice; it is retained for callers that adapt a
 *      task-bearing shape into `storyGroups`.
 *   2. **Explicit (story body)**: Story A body contains `blocked by #B` →
 *      Story A depends on Story B.
 *
 * After merging both sources, runs `assignLayers` to produce wave indices.
 *
 * > **Focus-overlap engine removed (Story #3906).** A third source — a
 * > focus-area overlap engine that rolled task-level `focusAreas` / `scope`
 * > up to the Story level and serialized "overlapping" Stories — was deleted
 * > because Task deletion in the 2-tier migration left every Story's task
 * > list empty, so the rollup produced empty focus bags and the engine added
 * > **zero** edges on every real plan. It advertised file-contention
 * > serialization it never delivered. Cross-Story prerequisites are carried
 * > by explicit `blocked by` declarations (source 2 above).
 *
 * @param {Map<number, {storyId: number|string, tasks: object[]}>} storyGroups
 *   Map of storyId → { storyId, tasks: [{ id, dependsOn }] }
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

  // Detect cycles in the dependency-derived graph. A cycle is a planning
  // error.
  const cycle = detectCycle(storyAdjacency);
  if (cycle) {
    throw new Error(
      `[Graph] Story-level dependency cycle detected: ${cycle.join(' → ')}. ` +
        'This usually means cross-story task dependencies form a circular chain.',
    );
  }

  // Assign layers (waves) to stories
  return assignLayers(storyAdjacency);
}
