/**
 * manifest-render-waves.js
 *
 * Presentation-only: emits the per-wave `## <emoji> Wave N` H2 sections
 * (with nested per-Story H3 headings and inline checkbox Task lists) that
 * sit beneath the Wave Summary table in the dispatch manifest. The TOC
 * links emitted by `renderWaveSections` jump directly into the H2
 * anchors emitted here.
 *
 * Extracted from `manifest-formatter.js` (Story #1849 Task #1870). The
 * shape-guard cascade lives behind a single private `validateWaveSection`
 * predicate so `renderNestedWaveSections` reads as a straight projection
 * and lands below CRAP 12.
 *
 * Imports the small pure helpers from `manifest-helpers.js` — the
 * formatter re-exports them so existing call-sites that read these
 * names off `manifest-formatter.js` keep working.
 */

import { AGENT_LABELS } from '../label-constants.js';
import {
  computeStoryProgress,
  deriveStorySymbol,
  deriveWaveStatus,
  topoSortTasks,
  waveHeadingText,
} from './manifest-helpers.js';

/**
 * Private: shape-guard for the per-level nodes touched by the wave
 * renderer. Centralising the checks keeps `renderNestedWaveSections`
 * linear — the function reads as a straight projection from `storyManifest`
 * into Markdown without re-asserting Array-ness at each loop.
 *
 * `level` describes which input the renderer is about to walk:
 *   - `'storyManifest'` → top-level `storyManifest[]` array
 *   - `'story'`         → a single Story manifest entry (object)
 *   - `'tasks'`         → a Story's `tasks[]` array
 *
 * Returns `true` when the node satisfies the contract; the caller skips
 * or substitutes an empty list when `false`.
 *
 * @param {string} level
 * @param {unknown} value
 * @returns {boolean}
 */
function validateWaveSection(level, value) {
  switch (level) {
    case 'storyManifest':
    case 'tasks':
      return Array.isArray(value);
    case 'story':
      return value !== null && typeof value === 'object';
    default:
      return false;
  }
}

/**
 * Pick the inline tail rendered after the per-wave count blockquote.
 * Pure derivation — only adds context the table doesn't already carry:
 * the gating wave when this one is Blocked, or the parallel-fan-out
 * count when multiple Stories run in parallel in a Ready wave.
 *
 * @param {{ word: string }} status
 * @param {number} waveIdx
 * @param {number[]} sortedWaves
 * @param {number} storyCount
 * @returns {string}
 */
function pickWaveTail(status, waveIdx, sortedWaves, storyCount) {
  if (status.word === 'Blocked') {
    const priorWaves = sortedWaves.filter((sw) => sw < waveIdx);
    const lastPrior = priorWaves[priorWaves.length - 1];
    if (lastPrior !== undefined) return ` · gated on Wave ${lastPrior}`;
    return '';
  }
  if (status.word === 'Ready' && storyCount > 1) {
    return ` · ${storyCount} run in parallel`;
  }
  return '';
}

/**
 * Group Stories into per-wave buckets and accumulate per-wave totals.
 * Pure helper — keeps the bookkeeping outside the main render loop.
 *
 * @param {object[]} waveStories
 * @returns {{ waveGroups: Map<number, object[]>, waveStats: Map<number, { stories: number, tasks: number, done: number }> }}
 */
function groupStoriesByWave(waveStories) {
  const waveGroups = new Map();
  const waveStats = new Map();
  for (const story of waveStories) {
    const w = story.earliestWave ?? -1;
    if (!waveGroups.has(w)) {
      waveGroups.set(w, []);
      waveStats.set(w, { stories: 0, tasks: 0, done: 0 });
    }
    waveGroups.get(w).push(story);
    const stat = waveStats.get(w);
    stat.stories++;
    stat.tasks += story.tasks.length;
    stat.done += story.tasks.filter(
      (t) => t.status === AGENT_LABELS.DONE,
    ).length;
  }
  return { waveGroups, waveStats };
}

/**
 * Render the inline checkbox task list under one Story heading, with
 * `*(after #N)*` callouts for in-Story dependencies only.
 *
 * @param {object} story
 * @returns {string[]} lines
 */
function renderStoryTaskList(story) {
  if (story.tasks.length === 0) return ['_(no tasks)_'];

  const lines = [];
  // Order Tasks root → blocked-last so the manifest reads in execution
  // order. Annotate each Task that has any in-Story dependency with the
  // most-recent dep (Story #1194 Task #1213) — "most recent" is the dep
  // whose work has to land last for this Task to unblock.
  const sortedTasks = topoSortTasks(story.tasks);
  const inStoryIds = new Set(story.tasks.map((t) => String(t.taskId)));
  const positionInSort = new Map(
    sortedTasks.map((t, idx) => [String(t.taskId), idx]),
  );
  for (const task of sortedTasks) {
    const isDone = task.status === AGENT_LABELS.DONE;
    const checkbox = isDone ? '[x]' : '[ ]';
    const taskTitle = task.taskSlug || task.title || '';
    const inStoryDeps = (task.dependencies ?? []).filter((d) =>
      inStoryIds.has(String(d)),
    );
    let suffix = '';
    if (inStoryDeps.length > 0) {
      const latest = inStoryDeps.reduce((a, b) =>
        (positionInSort.get(String(a)) ?? -1) >
        (positionInSort.get(String(b)) ?? -1)
          ? a
          : b,
      );
      suffix = ` *(after #${latest})*`;
    }
    lines.push(`- ${checkbox} #${task.taskId} — ${taskTitle}${suffix}`);
  }
  return lines;
}

/**
 * Render one `## <emoji> Wave N` section per wave with nested per-Story H3
 * headings and inline checkbox Task lists. The TOC links from
 * `renderWaveSections` jump straight into these H2 anchors.
 *
 * @param {object[]} storyManifest
 * @returns {string} Markdown block, or empty string when nothing to render.
 */
export function renderNestedWaveSections(storyManifest) {
  if (!validateWaveSection('storyManifest', storyManifest)) return '';
  if (storyManifest.length === 0) return '';

  const waveStories = storyManifest.filter(
    (s) => validateWaveSection('story', s) && s.type !== 'feature',
  );
  const featureItems = storyManifest.filter(
    (s) => validateWaveSection('story', s) && s.type === 'feature',
  );

  const { waveGroups, waveStats } = groupStoriesByWave(waveStories);
  const sortedWaves = [...waveGroups.keys()].sort((a, b) => a - b);
  const lines = [];

  for (const waveIdx of sortedWaves) {
    const stories = waveGroups.get(waveIdx);
    const stat = waveStats.get(waveIdx);
    const waveLabel = waveIdx === -1 ? 'Ungrouped' : `Wave ${waveIdx}`;
    const status = deriveWaveStatus(waveIdx, waveStats, sortedWaves);

    // The H2 text and slug must match `renderWaveSections` exactly so the
    // TOC links land on the right anchor.
    lines.push(`## ${waveHeadingText(waveLabel, status.emoji)}`);
    lines.push('');

    const tail = pickWaveTail(status, waveIdx, sortedWaves, stories.length);
    lines.push(
      `> ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} · ${stat.done}/${stat.tasks} tasks${tail}`,
    );
    lines.push('');

    for (const story of stories) {
      const sp = computeStoryProgress(story);
      const symbol = deriveStorySymbol(story);
      const titleCandidate = story.storyTitle || story.storySlug || '';
      lines.push(
        `### ${symbol} #${story.storyId} — ${titleCandidate} · ${sp.done}/${sp.total} tasks`,
      );
      lines.push('');
      const tasksList = validateWaveSection('tasks', story.tasks)
        ? renderStoryTaskList(story)
        : ['_(no tasks)_'];
      for (const line of tasksList) lines.push(line);
      lines.push('');
    }
  }

  if (featureItems.length > 0) {
    lines.push('## Feature Containers');
    lines.push('');
    lines.push(
      '> Features are organizational groupings and are **not directly executable**.',
    );
    lines.push('> Execute the Stories within each Feature instead.');
    lines.push('');
    lines.push('| Feature | Title | Child Tasks |');
    lines.push('| :--- | :--- | :--- |');
    for (const f of featureItems) {
      lines.push(`| #${f.storyId} | ${f.storySlug} | ${f.tasks.length} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Test-only: surface the private predicate so the sibling unit test can
// exercise each branch without going through the full renderer.
export const __testables = { validateWaveSection };
