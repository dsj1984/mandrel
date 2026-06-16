/**
 * lib/orchestration/manifest-builder.js — Manifest Building Logic
 *
 * 2-tier-only producer. Reads Story tickets from `allTickets` directly,
 * computes Story-scoped waves, and emits the `waves[].stories[]` /
 * Story-only `storyManifest` shape. The pre-Epic-#3163 Task-tier branch
 * has been removed; the framework no longer carries a Task-tier
 * producer path.
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { getStoryBranch, slugify } from '../git-utils.js';
import { TYPE_LABELS } from '../label-constants.js';
import { computeStoryWaves } from './dependency-analyzer.js';
import { STATE_LABELS } from './ticketing.js';

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
 * the 2-tier waves[].stories[] schema. Reads `## Acceptance` /
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
 * Build the Story-only manifest array used by the 2-tier hierarchy path.
 * Reads Story tickets directly from `allTickets`; there is no Task tier
 * to walk. Each entry exposes an empty `tasks: []` to keep downstream
 * consumers (renderers, dispatch helpers) on a single per-Story shape
 * until Category 4 of Epic #3163 rewrites them.
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
      // Carry the resolved cross-Story dependency edges on the entry so the
      // presentation layer can derive grouping depth at render time via
      // `assignLayers` (Story #4157) instead of trusting the persisted
      // `earliestWave`. This is the same `explicitStoryDeps` set the wave
      // computation consumed, already closed over the scheduled Story set.
      dependsOn: explicitStoryDeps.get(story.id) ?? [],
      tasks: [],
    };
  });
}

/**
 * Build the wave records for a 2-tier manifest. Each wave entry exposes a
 * `stories[]` projection (instead of the legacy `tasks[]`) so dispatch
 * consumers can fan Story execution out wave-by-wave without ever seeing
 * a `type::task` ticket.
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
 * Epic #3163, Category 2 deleted the legacy Task-tier
 * `waves[].tasks[]` branch and the Task-grouping import this module
 * used to pull from the removed helper. The producer is now
 * Story-only: it filters `allTickets` to the Story tier, computes
 * Story-scoped waves, and emits `waves[].stories[]` plus a Story-only
 * `storyManifest`.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildManifest({
  epicId,
  epic,
  allTickets,
  waves,
  dispatched,
  dryRun,
  agentTelemetry = null,
}) {
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
    hierarchy: '2-tier',
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
