import { assignLayers, detectCycle } from '../Graph.js';

/**
 * Story-level waves from cross-story task dependencies (empty in practice —
 * Stories carry no Tasks — kept for task-bearing adapters) plus explicit
 * `blocked by` edges. Throws on a cycle.
 *
 * @param {Map<number, {storyId: number|string, tasks: object[]}>} storyGroups
 * @param {Map<number|string, number[]>} [explicitDeps] storyId → blocker ids.
 * @returns {Map<number|string, number>} Map of storyId → wave index.
 */
export function computeStoryWaves(storyGroups, explicitDeps) {
  const taskToStory = new Map();
  for (const [storyId, group] of storyGroups.entries()) {
    for (const task of group.tasks) {
      taskToStory.set(task.id, storyId);
    }
  }

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

  const cycle = detectCycle(storyAdjacency);
  if (cycle) {
    throw new Error(
      `[Graph] Story-level dependency cycle detected: ${cycle.join(' → ')}. ` +
        'This usually means cross-story task dependencies form a circular chain.',
    );
  }

  return assignLayers(storyAdjacency);
}
