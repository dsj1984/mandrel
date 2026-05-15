/**
 * manifest-helpers.js
 *
 * Small pure helpers shared by the dispatch-manifest renderer
 * (`manifest-formatter.js`) and the per-wave renderer
 * (`manifest-render-waves.js`). Split out (Story #1849 Task #1871) so
 * the parent formatter can collapse to the wiring facade. The formatter
 * re-exports every name here so existing call-sites import paths stay
 * unchanged.
 */

import { AGENT_LABELS } from '../label-constants.js';

/**
 * Pick the per-Story symbol for the wave-grouped Story table:
 *   🚧 — at least one task is `agent::blocked`
 *   ✅ — every task is `agent::done`
 *   🔄 — some task is `agent::done` or `agent::executing` (not all done)
 *   ⬜ — nothing started yet (planning-time default)
 *
 * Pure: derives state from `s.tasks[].status` only.
 *
 * @param {{ tasks: Array<{ status?: string }> }} story
 * @returns {string}
 */
export function deriveStorySymbol(story) {
  const tasks = story?.tasks ?? [];
  if (tasks.length === 0) return '⬜';
  const blocked = tasks.some((t) => t.status === AGENT_LABELS.BLOCKED);
  if (blocked) return '🚧';
  const done = tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  if (done === tasks.length) return '✅';
  if (done > 0 || tasks.some((t) => t.status === AGENT_LABELS.EXECUTING)) {
    return '🔄';
  }
  return '⬜';
}

/**
 * Compute aggregate progress numbers for a dispatch manifest. Pure.
 *
 * @param {object} manifest
 * @returns {{
 *   taskPct: number,
 *   doneTasks: number,
 *   totalTasks: number,
 *   doneStories: number,
 *   totalStories: number,
 *   storyWaveCount: number,
 * }}
 */
export function computeProgress(manifest) {
  const summary = manifest?.summary ?? {};
  const storyManifest = manifest?.storyManifest ?? [];

  const allStoryItems = storyManifest.filter(
    (s) => s.type === 'story' && s.storyId !== '__ungrouped__',
  );
  const doneStories = allStoryItems.filter(
    (s) =>
      s.tasks.length > 0 &&
      s.tasks.every((t) => t.status === AGENT_LABELS.DONE),
  ).length;

  const storyWaveSet = new Set(
    storyManifest.map((s) => s.earliestWave).filter((w) => w !== -1),
  );

  return {
    taskPct: summary.progressPercent ?? 0,
    doneTasks: summary.doneTasks ?? 0,
    totalTasks: summary.totalTasks ?? 0,
    doneStories,
    totalStories: allStoryItems.length,
    storyWaveCount: storyWaveSet.size || 1,
  };
}

/**
 * Derive a GitHub-flavoured Markdown anchor slug from a heading's
 * visible text. GitHub's slug algorithm:
 *   1. Lowercase the text.
 *   2. Strip emojis and other non-letter/digit/space/hyphen Unicode.
 *   3. Replace runs of whitespace with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugifyHeading(text) {
  const raw = String(text ?? '');
  const stripped = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim();
  return stripped.replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the visible H2 text for a wave row, e.g. `🚀 Wave 0`. The
 * status word lives only in the Wave Summary TOC; the H2 carries the
 * emoji as a visual anchor.
 *
 * @param {string} waveLabel e.g. `Wave 0` or `Ungrouped`
 * @param {string} emoji     e.g. `🚀`, `⏳`, `✅`
 * @returns {string}
 */
export function waveHeadingText(waveLabel, emoji) {
  return `${emoji} ${waveLabel}`;
}

/**
 * Render a fixed-width unicode progress bar, e.g. `█████░░░░░░░░░░░░░░░`.
 *
 * @param {number} percent  0..100
 * @param {object} [opts]
 * @param {number} [opts.width=20]
 * @returns {string}
 */
export function renderProgressBar(percent, opts = {}) {
  const width = opts.width ?? 20;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Derive the per-wave status label and emoji used by both the TOC table
 * and the per-wave H2 heading.
 *
 * @param {number} waveIdx
 * @param {Map<number, { tasks: number, done: number }>} waveStats
 * @param {number[]} sortedWaves
 * @returns {{ emoji: string, word: string, label: string }}
 */
export function deriveWaveStatus(waveIdx, waveStats, sortedWaves) {
  const stat = waveStats.get(waveIdx);
  const isDone = stat && stat.tasks > 0 && stat.done === stat.tasks;
  if (isDone) return { emoji: '✅', word: 'Done', label: '✅ Done' };
  const isReady =
    waveIdx === 0 ||
    sortedWaves
      .filter((sw) => sw < waveIdx)
      .every((sw) => {
        const swStat = waveStats.get(sw);
        return swStat.done === swStat.tasks;
      });
  return isReady
    ? { emoji: '🚀', word: 'Ready', label: '🚀 Ready' }
    : { emoji: '⏳', word: 'Blocked', label: '⏳ Blocked' };
}

/**
 * Render the "## Wave Summary" section for a manifest's wave-eligible
 * items (Stories only — Features are containers and excluded by caller).
 *
 * @param {object[]} waveEligible
 * @returns {string} Markdown block, or empty string when nothing to render.
 */
export function renderWaveSections(waveEligible) {
  if (!waveEligible || waveEligible.length === 0) return '';

  const waveStats = new Map();
  for (const s of waveEligible) {
    const w = s.earliestWave ?? -1;
    if (!waveStats.has(w)) {
      waveStats.set(w, { stories: 0, tasks: 0, done: 0 });
    }
    const stat = waveStats.get(w);
    stat.stories++;
    stat.tasks += s.tasks.length;
    stat.done += s.tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  }

  const sortedWaves = [...waveStats.keys()].sort((a, b) => a - b);
  const lines = [
    '## Wave Summary',
    '',
    '| Wave | Status | Stories | Tasks |',
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const w of sortedWaves) {
    const stat = waveStats.get(w);
    const waveLabel = w === -1 ? 'Ungrouped' : `Wave ${w}`;
    const status = deriveWaveStatus(w, waveStats, sortedWaves);
    const headingText = waveHeadingText(waveLabel, status.emoji);
    const anchor = slugifyHeading(headingText);
    const waveCell = `[${waveLabel}](#${anchor})`;
    lines.push(
      `| ${waveCell} | ${status.label} | ${stat.stories} | ${stat.done}/${stat.tasks} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Topologically sort a Story's Tasks by their `dependencies` (in-Story
 * `depends_on` ids). Stable: ties resolve in the original declaration
 * order. Cross-Story dependencies (ids that aren't in the same
 * `tasks[]`) are ignored.
 *
 * Pure / O(n + e) — Kahn's algorithm with a deterministic tie-breaker.
 *
 * @param {Array<{ taskId: number|string, dependencies?: Array<number|string> }>} tasks
 * @returns {Array}
 */
export function topoSortTasks(tasks) {
  if (!tasks || tasks.length === 0) return [];
  const idSet = new Set(tasks.map((t) => String(t.taskId)));
  const order = new Map();
  tasks.forEach((t, idx) => {
    order.set(String(t.taskId), idx);
  });

  const inDegree = new Map();
  const adj = new Map();
  for (const t of tasks) {
    const tid = String(t.taskId);
    if (!inDegree.has(tid)) inDegree.set(tid, 0);
    if (!adj.has(tid)) adj.set(tid, []);
    for (const dep of t.dependencies ?? []) {
      const did = String(dep);
      if (!idSet.has(did)) continue;
      inDegree.set(tid, (inDegree.get(tid) ?? 0) + 1);
      if (!adj.has(did)) adj.set(did, []);
      adj.get(did).push(tid);
    }
  }

  const ready = tasks
    .map((t) => String(t.taskId))
    .filter((tid) => (inDegree.get(tid) ?? 0) === 0)
    .sort((a, b) => order.get(a) - order.get(b));

  const out = [];
  const byId = new Map(tasks.map((t) => [String(t.taskId), t]));
  while (ready.length > 0) {
    const tid = ready.shift();
    out.push(byId.get(tid));
    for (const next of adj.get(tid) ?? []) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) {
        let i = 0;
        while (i < ready.length && order.get(ready[i]) < order.get(next)) i++;
        ready.splice(i, 0, next);
      }
    }
  }

  // Cycle fallback: append any leftover tasks in original order so we
  // never silently drop work.
  if (out.length < tasks.length) {
    for (const t of tasks) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Compute per-Story aggregates for the nested wave layout: a 0..100
 * progress percent and the done/total task counts. Pure.
 *
 * @param {{ tasks?: Array<{ status?: string }> }} story
 * @returns {{ pct: number, done: number, total: number }}
 */
export function computeStoryProgress(story) {
  const tasks = story?.tasks ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { pct, done, total };
}
