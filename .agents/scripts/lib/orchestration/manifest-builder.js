/**
 * lib/orchestration/manifest-builder.js — Manifest Building Logic
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { getStoryBranch, getTaskBranch, slugify } from '../git-utils.js';
import { TYPE_LABELS } from '../label-constants.js';
import { computeStoryWaves } from './dependency-analyzer.js';
import { groupTasksByStory } from './story-grouper.js';
import { STATE_LABELS } from './ticketing.js';

/**
 * Detect 3-tier hierarchy from inputs. 3-tier inputs carry zero
 * `type::task` tickets — every leaf is a `type::story`. This is the
 * structural signal `buildManifest` keys off so it never invokes the
 * Task-centric `groupTasksByStory` for a Story-only Epic.
 *
 * @param {object[]} tasks
 * @param {object[]} allTickets
 * @returns {boolean}
 */
function isThreeTierShape(tasks, allTickets) {
  if (Array.isArray(tasks) && tasks.length > 0) return false;
  if (!Array.isArray(allTickets) || allTickets.length === 0) return false;
  return allTickets.some((t) =>
    (t.labelSet ?? new Set(t.labels ?? [])).has(TYPE_LABELS.STORY),
  );
}

/**
 * Extract the markdown list items under a `## <heading>` section of a
 * Story body. Returns an empty array when the section is missing or has
 * no list items. Recognises both `- ` (incl. `- [ ]` / `- [x]`) and
 * `* ` bullet markers — the same set the schema expects to round-trip
 * verbatim per the manifest dispatch-manifest contract.
 *
 * @param {string} body
 * @param {string} heading
 * @returns {string[]}
 */
function extractSectionList(body, heading) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const pattern = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`,
    'mi',
  );
  const startMatch = body.match(pattern);
  if (!startMatch || startMatch.index == null) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = body.slice(startIdx);
  const nextHeading = rest.search(/^##\s+/m);
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const items = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (m && m[1].length > 0) items.push(m[1].trim());
  }
  return items;
}

/**
 * Project a Story ticket into the inline-acceptance/verify shape required by
 * the 3-tier waves[].stories[] schema. Reads `## Acceptance` /
 * `## Acceptance Criteria` and `## Verify` sections from the body.
 *
 * @param {object} story
 * @param {number} epicId
 * @returns {object}
 */
function projectStoryForWave(story, epicId) {
  const body = story.body ?? '';
  const acceptanceCriteria = extractSectionList(body, 'Acceptance Criteria');
  const acceptanceItems =
    acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : extractSectionList(body, 'Acceptance');
  const verifyItems = extractSectionList(body, 'Verify');
  const fromBody = parseBlockedBy(body);
  const fromField = Array.isArray(story.dependencies)
    ? story.dependencies.map(Number)
    : [];
  const dependsOn = [...new Set([...fromBody, ...fromField])].filter((id) =>
    Number.isInteger(id),
  );
  const labels = story.labels ?? [];
  const personaLabel = labels.find((l) => l.startsWith('persona::'));
  const persona =
    story.persona ??
    (personaLabel ? personaLabel.replace('persona::', '') : 'engineer');
  const status =
    story.status ??
    labels.find((l) => l.startsWith('agent::')) ??
    'agent::ready';

  return {
    storyId: story.id,
    title: story.title ?? '',
    status,
    branch: getStoryBranch(epicId, story.id),
    persona,
    acceptance: acceptanceItems,
    verify: verifyItems,
    dependsOn,
  };
}

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
 * Build the Story-only manifest array used by the 3-tier hierarchy path.
 * No Task records exist under a 3-tier Epic, so this projection reads
 * Story tickets directly from `allTickets` rather than invoking
 * `groupTasksByStory`. Each entry mirrors the 4-tier `buildStoryManifest`
 * shape with an empty `tasks: []` to keep downstream consumers (renderers,
 * dispatch helpers) happy without forking their per-Story walk.
 *
 * @param {object[]} stories  Story tickets (each with `id`, `title`,
 *                            `body`, `labels`, optional `dependencies`).
 * @param {number}   epicId
 * @returns {object[]}
 */
function buildStoryOnlyManifest(stories, epicId) {
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const explicitStoryDeps = new Map();
  for (const story of stories) {
    const fromBody = parseBlockedBy(story.body ?? '');
    const fromField = Array.isArray(story.dependencies)
      ? story.dependencies.map(Number)
      : [];
    const merged = [...new Set([...fromBody, ...fromField])].filter(
      (id) => Number.isInteger(id) && id !== story.id && storyById.has(id),
    );
    if (merged.length > 0) explicitStoryDeps.set(story.id, merged);
  }

  // Reuse `computeStoryWaves` by adapting Stories to its `storyGroups`
  // input shape: a Map keyed by storyId whose values look like grouper
  // output. With no Tasks, every group's `tasks: []` collapses the
  // task-level wave inference to a no-op; only `explicitDeps` drives
  // ordering.
  const storyGroups = new Map(
    stories.map((s) => [s.id, { storyId: s.id, tasks: [] }]),
  );
  const storyWaves = computeStoryWaves(storyGroups, explicitStoryDeps);

  return stories.map((story) => {
    const earliestWave = storyWaves.get(story.id) ?? -1;
    return {
      storyId: story.id,
      storyTitle: story.title ?? '',
      storySlug: slugify(story.title ?? `story-${story.id}`),
      type: 'story',
      branchName: getStoryBranch(epicId, story.id),
      earliestWave,
      tasks: [],
    };
  });
}

/**
 * Build the wave records for a 3-tier manifest. Each wave entry exposes a
 * `stories[]` projection (instead of the 4-tier `tasks[]`) so dispatch
 * consumers can fan Story execution out wave-by-wave without ever seeing a
 * `type::task` ticket.
 *
 * @param {object[][]} waves   Story waves (array of Story-ticket arrays).
 * @param {number}     epicId
 * @returns {object[]}
 */
function buildStoryWaves(waves, epicId) {
  return waves.map((wave, i) => ({
    waveIndex: i,
    stories: wave.map((s) => projectStoryForWave(s, epicId)),
  }));
}

/**
 * Build the full Dispatch Manifest object.
 *
 * Branches on input shape:
 * - **3-tier** (no `type::task` tickets among `allTickets`, at least one
 *   `type::story`): emits `waves[].stories[]` and a Story-only
 *   `storyManifest`. `groupTasksByStory` is **not** invoked.
 * - **4-tier** (the default): emits `waves[].tasks[]` and the
 *   Task-grouped `storyManifest` — byte-equivalent to the pre-3-tier
 *   manifest format.
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
  agentTelemetry = null,
  hierarchy,
}) {
  const allTicketsById = new Map((allTickets ?? []).map((t) => [t.id, t]));
  const threeTier =
    hierarchy === '3-tier' ||
    (hierarchy !== '4-tier' && isThreeTierShape(tasks, allTickets ?? []));

  if (threeTier) {
    const stories = (allTickets ?? []).filter((t) =>
      (t.labelSet ?? new Set(t.labels ?? [])).has(TYPE_LABELS.STORY),
    );
    const totalStories = stories.length;
    const doneStories = stories.filter((s) =>
      (s.labelSet ?? new Set(s.labels ?? [])).has(AGENT_DONE_LABEL),
    ).length;
    const progress =
      totalStories > 0 ? Math.round((doneStories / totalStories) * 100) : 0;

    return {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      epicId,
      epicTitle: epic?.title ?? '',
      executor: 'claude-code',
      dryRun,
      hierarchy: '3-tier',
      summary: {
        totalStories,
        doneStories,
        progressPercent: progress,
        totalWaves: waves.length,
        dispatched: dispatched.length,
      },
      waves: buildStoryWaves(waves, epicId),
      storyManifest: buildStoryOnlyManifest(stories, epicId),
      dispatched,
      agentTelemetry,
    };
  }

  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === AGENT_DONE_LABEL).length;
  const progress =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    epicId,
    epicTitle: epic?.title ?? '',
    executor: 'claude-code',
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
