import { extractEpicIdFromBody } from '../dependency-parser.js';
import { buildGraph, detectCycle, topologicalSort } from '../Graph.js';
import { getEpicBranch, getStoryBranch } from '../git-utils.js';
import { fetchTasks } from './task-fetcher.js';

/**
 * Execute a single Story
 * Identifies the parent Epic, retrieves sibling tasks, sorts them by DAG,
 * and generates an execution manifest.
 *
 * @param {{
 *   story: object,
 *   provider: import('../ITicketingProvider.js').ITicketingProvider,
 *   dryRun?: boolean
 * }} options
 * @returns {Promise<object>} Story Execution Manifest
 */
export async function executeStory(options) {
  const { story, provider, dryRun = false } = options;

  // Find the parent Epic. Stories reference their Epic via `Epic: #NNN`
  // in the body — extraction lives in `lib/dependency-parser.js`.
  const epicId = extractEpicIdFromBody(story.body);

  const manifest = {
    type: 'story-execution',
    generatedAt: new Date().toISOString(),
    dryRun,
    stories: [],
  };

  let allTasks = [];
  if (epicId) {
    allTasks = await fetchTasks(provider, epicId);
  }

  // Filter to tasks belonging to THIS story (via parent: #STORY_ID)
  const storyTasks = allTasks.filter((t) => {
    const parentMatch = t.body?.match(/parent:\s*#(\d+)/i);
    return parentMatch && Number.parseInt(parentMatch[1], 10) === story.id;
  });

  // Sort tasks by DAG
  const { adjacency, taskMap } = buildGraph(storyTasks);

  let sortedTasks = [];
  try {
    const cycle = detectCycle(adjacency);
    if (cycle) {
      throw new Error(`Cycle detected: ${cycle.join(' -> ')}`);
    }
    sortedTasks = topologicalSort(adjacency, taskMap);
  } catch (err) {
    console.error(
      `[executeStory] DAG sort failed for Story #${story.id}:`,
      err.message,
    );
    sortedTasks = storyTasks; // Fallback to raw list
  }

  const branchName = epicId
    ? getStoryBranch(epicId, story.id)
    : `story-${story.id}`;
  const epicBranch = epicId ? getEpicBranch(epicId) : null;

  manifest.stories.push({
    storyId: story.id,
    storyTitle: story.title,
    epicId,
    epicBranch,
    branchName,
    tasks: sortedTasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
    })),
  });

  return manifest;
}
