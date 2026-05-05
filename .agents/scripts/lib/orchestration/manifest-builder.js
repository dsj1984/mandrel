/**
 * lib/orchestration/manifest-builder.js — Manifest Building Logic
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { getStoryBranch, getTaskBranch, slugify } from '../git-utils.js';
import { TYPE_LABELS } from '../label-constants.js';
import { computeStoryWaves } from './dependency-analyzer.js';
import { groupTasksByStory } from './story-grouper.js';
import { STATE_LABELS } from './ticketing.js';

const AGENT_DONE_LABEL = STATE_LABELS.DONE;

/**
 * Resolve the branch name for a task, preferring its parent Story branch.
 *
 * @param {object} task
 * @param {Map<number, object>} allTicketsById
 * @param {number} epicId
 * @returns {string}
 */
export function getResolvedBranch(task, allTicketsById, epicId) {
  const parentMatch = task.body?.match(/parent:\s*#(\d+)/i);
  if (parentMatch) {
    const parentId = Number.parseInt(parentMatch[1], 10);
    const parentTicket = allTicketsById.get(parentId);
    if (parentTicket?.labels.includes(TYPE_LABELS.STORY)) {
      return getStoryBranch(epicId, parentId);
    }
  }
  return getTaskBranch(epicId, task.id);
}

/**
 * Resolve story-to-story dependency edges from the same source order the epic
 * runner uses so dispatch manifest and runtime wave DAG never disagree:
 *   1) body markers via parseBlockedBy (canonical for GitHub tickets)
 *   2) optional provider `dependencies` array (fixture/custom providers)
 */
function resolveStoryDeps(groups, ticketById) {
  const deps = new Map();
  for (const storyId of groups.keys()) {
    if (storyId === '__ungrouped__') continue;
    const ticket = ticketById.get(storyId);
    if (!ticket) continue;
    const fromBody = parseBlockedBy(ticket.body ?? '');
    const fromField = Array.isArray(ticket.dependencies)
      ? ticket.dependencies.map(Number)
      : [];
    const merged = [...new Set([...fromBody, ...fromField])].filter(
      (id) => Number.isInteger(id) && id !== storyId && groups.has(id),
    );
    if (merged.length > 0) deps.set(storyId, merged);
  }
  return deps;
}

/**
 * Build the story-centric manifest array.
 *
 * @param {object[]} tasks
 * @param {object[]} allTickets
 * @param {number}   epicId
 * @returns {object[]}
 */
function buildStoryManifest(tasks, allTickets, epicId) {
  const groups = groupTasksByStory(tasks, allTickets, epicId);
  const ticketById = new Map(allTickets.map((t) => [t.id, t]));
  const explicitStoryDeps = resolveStoryDeps(groups, ticketById);
  const storyWaves = computeStoryWaves(groups, explicitStoryDeps);

  return [...groups.values()].map((group) => {
    const earliestWave = storyWaves.get(group.storyId) ?? -1;

    const slug =
      group.storyId === '__ungrouped__'
        ? 'ungrouped'
        : slugify(group.storyTitle);

    const branchName =
      group.storyId === '__ungrouped__'
        ? getTaskBranch(epicId, 'ungrouped')
        : getStoryBranch(epicId, group.storyId);

    return {
      storyId: group.storyId,
      storyTitle: group.storyTitle,
      storySlug: slug,
      type: group.type,
      branchName,
      earliestWave,
      tasks: group.tasks.map((t) => ({
        taskId: t.id,
        taskSlug: slugify(t.title),
        parentSlug: slug,
        status: t.status,
        dependencies: t.dependsOn ?? [],
      })),
    };
  });
}

/**
 * Build the full Dispatch Manifest object.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildManifest({
  epicId,
  epic,
  tasks,
  allTickets,
  waves,
  dispatched,
  dryRun,
  adapter,
  agentTelemetry = null,
}) {
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === AGENT_DONE_LABEL).length;
  const progress =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const allTicketsById = new Map((allTickets ?? []).map((t) => [t.id, t]));

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    epicId,
    epicTitle: epic?.title ?? '',
    executor: adapter.executorId,
    dryRun,
    summary: {
      totalTasks,
      doneTasks,
      progressPercent: progress,
      totalWaves: waves.length,
      dispatched: dispatched.length,
    },
    waves: waves.map((wave, i) => ({
      waveIndex: i,
      tasks: wave.map((t) => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        branch: getResolvedBranch(t, allTicketsById ?? new Map(), epicId),
        persona: t.persona,
        mode: t.mode,
        skills: t.skills,
        focusAreas: t.focusAreas,
        dependsOn: t.dependsOn,
      })),
    })),
    storyManifest: buildStoryManifest(tasks, allTickets ?? [], epicId),
    dispatched,
    agentTelemetry,
  };
}
