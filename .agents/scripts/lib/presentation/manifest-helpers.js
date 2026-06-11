/**
 * manifest-helpers.js
 *
 * Small pure helpers shared by the dispatch-manifest renderer
 * (`manifest-formatter.js`) and the per-wave renderer
 * (`manifest-render-waves.js`). Split out (Story #1849 Task #1871) so
 * the parent formatter can collapse to the wiring facade. The formatter
 * re-exports every name here so existing call-sites' import paths stay
 * unchanged.
 *
 * Post-2-tier (Story #3194 / #3413, Epic #3163): the helpers consume the
 * Story-only manifest shape. Stories carry their lifecycle state on a
 * top-level `status` field (the parent Story's `agent::*` label) — the
 * old per-Story Task array, the per-Task id indirection, and the
 * Task-tier summary pass-through have all been deleted. `computeProgress`
 * now reports Story-tier aggregates only.
 */

import { AGENT_LABELS } from '../label-constants.js';

/**
 * Pick the per-Story symbol for the wave-grouped Story table:
 *   🚧 — Story is `agent::blocked`
 *   ✅ — Story is `agent::done`
 *   🔄 — Story is `agent::executing` (in flight)
 *   ⬜ — Story is `agent::ready` or unset (planning-time default)
 *
 * Pure: derives the symbol from `story.status` only.
 *
 * @param {{ status?: string }} story
 * @returns {string}
 */
export function deriveStorySymbol(story) {
  const status = story?.status;
  if (status === AGENT_LABELS.BLOCKED) return '🚧';
  if (status === AGENT_LABELS.DONE) return '✅';
  if (status === AGENT_LABELS.EXECUTING) return '🔄';
  return '⬜';
}

/**
 * Compute aggregate progress numbers for a dispatch manifest. Pure.
 *
 * Story-only shape (Epic #3163, Story #3413): `doneStories` /
 * `totalStories` are derived from each Story's top-level `status` (the
 * parent Story's `agent::*` label), not from a nested Task array.
 * `storyPct` is the Story-tier completion percentage; the residual
 * Task-tier pass-through fields have been deleted.
 *
 * @param {object} manifest
 * @returns {{
 *   storyPct: number,
 *   doneStories: number,
 *   totalStories: number,
 *   storyWaveCount: number,
 * }}
 */
export function computeProgress(manifest) {
  const storyManifest = manifest?.storyManifest ?? [];

  const allStoryItems = storyManifest.filter(
    (s) => s.type === 'story' && s.storyId !== '__ungrouped__',
  );
  const totalStories = allStoryItems.length;
  const doneStories = allStoryItems.filter(
    (s) => s.status === AGENT_LABELS.DONE,
  ).length;

  const storyWaveSet = new Set(
    storyManifest.map((s) => s.earliestWave).filter((w) => w !== -1),
  );

  return {
    storyPct:
      totalStories > 0 ? Math.round((doneStories / totalStories) * 100) : 0,
    doneStories,
    totalStories,
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
 * The waveStats map carries an opaque pair `{ total, done }` per wave —
 * the meaning of the unit is the caller's choice. Story-only callers
 * (`renderWaveSections` here) pass Story counts; Task-aware callers
 * (the wave renderer, pending Story #3196's rewrite) pass Task counts.
 * Either way, a wave is "done" when `done === total > 0`. "Ready"
 * requires every prior wave to be done; otherwise "Blocked".
 *
 * @param {number} waveIdx
 * @param {Map<number, { total: number, done: number }>} waveStats
 * @param {number[]} sortedWaves
 * @returns {{ emoji: string, word: string, label: string }}
 */
export function deriveWaveStatus(waveIdx, waveStats, sortedWaves) {
  const stat = waveStats.get(waveIdx);
  const isDone = stat && stat.total > 0 && stat.done === stat.total;
  if (isDone) return { emoji: '✅', word: 'Done', label: '✅ Done' };
  const isReady =
    waveIdx === 0 ||
    sortedWaves
      .filter((sw) => sw < waveIdx)
      .every((sw) => {
        const swStat = waveStats.get(sw);
        return swStat.done === swStat.total;
      });
  return isReady
    ? { emoji: '🚀', word: 'Ready', label: '🚀 Ready' }
    : { emoji: '⏳', word: 'Blocked', label: '⏳ Blocked' };
}

/**
 * Render the "## Wave Summary" section for a manifest's wave-eligible
 * items (Stories only — Features are containers and excluded by caller).
 *
 * Story-only shape: per-wave totals count Stories (not Tasks). Each
 * row reports `doneStories/storyCount` so the TOC reflects Story-tier
 * progress directly.
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
      // `total` / `done` is the contract `deriveWaveStatus` consumes;
      // here each unit is a Story. Other callers (the wave renderer,
      // pending Story #3196's rewrite) pass Task counts under the same
      // key names so the predicate stays unit-agnostic.
      waveStats.set(w, { total: 0, done: 0 });
    }
    const stat = waveStats.get(w);
    stat.total++;
    if (s.status === AGENT_LABELS.DONE) stat.done++;
  }

  const sortedWaves = [...waveStats.keys()].sort((a, b) => a - b);
  const lines = [
    '## Wave Summary',
    '',
    '| Wave | Status | Stories |',
    '| :--- | :--- | :--- |',
  ];

  for (const w of sortedWaves) {
    const stat = waveStats.get(w);
    const waveLabel = w === -1 ? 'Ungrouped' : `Wave ${w}`;
    const status = deriveWaveStatus(w, waveStats, sortedWaves);
    const headingText = waveHeadingText(waveLabel, status.emoji);
    const anchor = slugifyHeading(headingText);
    const waveCell = `[${waveLabel}](#${anchor})`;
    lines.push(
      `| ${waveCell} | ${status.label} | ${stat.done}/${stat.total} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
