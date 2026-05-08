/**
 * task-graph-builder.js — Stage 4 of the story-init pipeline.
 *
 * Enumerates child Tasks of the Story, then topologically sorts them using
 * `blocked by` edges that reference other Tasks in the same set. Inter-Task
 * dependencies outside the child set are ignored (they are handled by the
 * Story-level blocker validator).
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { buildGraph, detectCycle, topologicalSort } from '../Graph.js';
import { Logger } from '../Logger.js';
import { fetchChildTasks } from '../story-lifecycle.js';

function sortTasksByDependencies(tasks) {
  if (tasks.length <= 1) return tasks;

  const graphTasks = tasks.map((t) => ({
    ...t,
    dependsOn: parseBlockedBy(t.body ?? '').filter((dep) =>
      tasks.some((tt) => tt.id === dep),
    ),
  }));
  const { adjacency, taskMap } = buildGraph(graphTasks);

  const cycle = detectCycle(adjacency);
  if (cycle) {
    throw new Error(
      `[story-init] Dependency cycle detected among child tasks: ` +
        `#${cycle.join(' → #')}. Fix the \`blocked by\` references before retrying.`,
    );
  }

  return topologicalSort(adjacency, taskMap);
}

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {number} deps.input.storyId
 * @returns {Promise<{ sortedTasks: Array<object> }>}
 */
export async function buildTaskGraph({ provider, logger, input }) {
  const { storyId } = input;
  const warn = logger?.warn ?? ((msg) => Logger.error(msg));
  const progress = logger?.progress ?? (() => {});

  const tasks = await fetchChildTasks(provider, storyId);

  if (tasks.length === 0) {
    warn(
      `[story-init] Warning: Story #${storyId} has no child Tasks. The agent will need to work from the Story body directly.`,
    );
  }

  const sortedTasks = sortTasksByDependencies(tasks);
  progress(
    'TASKS',
    `Found ${sortedTasks.length} child Task(s) in dependency order`,
  );

  return { sortedTasks };
}

export { sortTasksByDependencies };
