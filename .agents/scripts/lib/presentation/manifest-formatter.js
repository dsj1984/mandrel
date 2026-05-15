/**
 * manifest-formatter.js
 *
 * Wiring facade for the dispatch-manifest presentation layer. Composes
 * the projection (`manifest-builder.js`), the per-wave renderer
 * (`manifest-render-waves.js`), the operating-procedures `<details>` block
 * (`manifest-procedures.js`), and the story-execution + CLI dispatch
 * views (`manifest-story-views.js`) into one Markdown emission for the
 * Epic-level dispatch manifest, then memoises the result on a per-input
 * content hash so the progress-reporter does not re-render unchanged
 * manifests every tick.
 *
 * Pure: no fs / provider / config I/O. Callers that need injected values
 * (e.g. `renderStoryManifestMarkdown`'s script-path hints) pass them via
 * `opts`. The outer façade `manifest-renderer.js` re-exports this module
 * and owns the one impure helper that reads config to build the options
 * bag.
 *
 * All small pure helpers (`deriveStorySymbol`, `computeProgress`,
 * `slugifyHeading`, `waveHeadingText`, `renderProgressBar`,
 * `deriveWaveStatus`, `renderWaveSections`, `topoSortTasks`,
 * `computeStoryProgress`) stay in this file — they are the shared
 * vocabulary of the dispatch manifest and are imported by both the
 * per-wave renderer and external callers via this module's exports.
 */

import { createHash } from 'node:crypto';
import { AGENT_LABELS } from '../label-constants.js';
import { buildManifestFromSpec } from './manifest-builder.js';
import { renderProceduresAndLegendDetails } from './manifest-procedures.js';
import { renderNestedWaveSections } from './manifest-render-waves.js';
import {
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
} from './manifest-story-views.js';

// Re-exported so existing call-sites and tests that imported these names
// from `manifest-formatter.js` keep working without a path change
// (Story #1849 split).
export {
  buildManifestFromSpec,
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
  renderNestedWaveSections,
  renderProceduresAndLegendDetails,
};

// ---------------------------------------------------------------------------
// Pure render helpers (Story #484 — exported for direct fixture testing)
// ---------------------------------------------------------------------------

/**
 * Pick the per-Story symbol for the wave-grouped Story table:
 *   🚧 — at least one task is `agent::blocked`
 *   ✅ — every task is `agent::done`
 *   🔄 — some task is `agent::done` or `agent::executing` (not all done)
 *   ⬜ — nothing started yet (planning-time default)
 *
 * Pure: derives state from `s.tasks[].status` only. The runtime fills those
 * statuses from current GitHub labels via `resolveAndDispatch` so the symbol
 * advances as `dashboardRefreshPhase` re-renders after each Story merge.
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
 * Compute aggregate progress numbers for a dispatch manifest. Pure — derives
 * everything from the manifest fields it is given.
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
 * Derive a GitHub-flavoured Markdown anchor slug from a heading's visible
 * text. GitHub's slug algorithm (per `jch/html-pipeline`'s TocFilter):
 *   1. Lowercase the text.
 *   2. Strip emojis and other non-letter/digit/space/hyphen Unicode.
 *   3. Replace runs of whitespace with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * Used by both the Wave Summary TOC and the per-wave H2 emission so the
 * link `href` and the anchor stay in lock-step.
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
 * Build the visible H2 text for a wave row, e.g. `🚀 Wave 0`. The status
 * word lives only in the Wave Summary TOC; the H2 carries the emoji as a
 * visual anchor and nothing else, so the per-wave section reads cleanly
 * top-to-bottom without echoing the table.
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
 * @param {number} [opts.width=20]  Total cells in the bar.
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
 * and the per-wave H2 heading. Single source of truth so the TOC link
 * slug and the H2 anchor stay in lock-step.
 *
 * @param {number} waveIdx                — current wave index (or -1)
 * @param {Map<number, { tasks: number, done: number }>} waveStats
 * @param {number[]} sortedWaves          — every wave index in ascending order
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
    // Both sides call `waveHeadingText` + `slugifyHeading` so the TOC
    // anchor stays in lock-step with the per-wave H2.
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
 * order so a Story with no edges renders Tasks exactly as authored.
 * Cross-Story dependencies (ids that aren't in the same `tasks[]`) are
 * ignored — the runtime resolves those at the wave-ordering layer.
 *
 * Pure / O(n + e) — Kahn's algorithm with a deterministic tie-breaker.
 *
 * @param {Array<{ taskId: number|string, dependencies?: Array<number|string> }>} tasks
 * @returns {Array} same task objects, sorted root → blocked-last.
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
      if (!idSet.has(did)) continue; // cross-Story edge: skip
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
  // never silently drop work. Upstream validation forbids cycles; this
  // keeps the renderer robust if it drifts.
  if (out.length < tasks.length) {
    for (const t of tasks) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Compute per-Story aggregates for the nested wave layout: a 0..100
 * progress percent and the done/total task counts. Pure — derived from
 * `story.tasks[]`.
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

// ---------------------------------------------------------------------------
// Dispatch manifest (Epic-level) Markdown — memoised public entry
// ---------------------------------------------------------------------------

let _lastManifestRef = null;
let _lastManifestHash = null;
let _lastManifestOutput = null;

function hashManifest(manifest) {
  return createHash('sha1')
    .update(JSON.stringify(manifest ?? null))
    .digest('hex');
}

/**
 * Clear the content-hash cache for `formatManifestMarkdown`. Intended
 * for tests and for callers that mutate manifest objects in place
 * between renders.
 */
export function __resetManifestFormatterCache() {
  _lastManifestRef = null;
  _lastManifestHash = null;
  _lastManifestOutput = null;
}

export function formatManifestMarkdown(manifest) {
  // Fast path: same manifest instance as last call (progress-reporter
  // reuses the same object across ticks when nothing has changed).
  if (manifest === _lastManifestRef && _lastManifestOutput !== null) {
    return _lastManifestOutput;
  }
  // Slow path: content-hash comparison for cases where the caller built
  // a fresh manifest object with identical content.
  const hash = hashManifest(manifest);
  if (hash === _lastManifestHash && _lastManifestOutput !== null) {
    _lastManifestRef = manifest;
    return _lastManifestOutput;
  }
  const output = _formatManifestMarkdownUncached(manifest);
  _lastManifestRef = manifest;
  _lastManifestHash = hash;
  _lastManifestOutput = output;
  return output;
}

function _formatManifestMarkdownUncached(manifest) {
  const { epicId, epicTitle, summary, storyManifest, generatedAt } = manifest;
  const progress = computeProgress(manifest);
  const lines = [];

  // Title + subtitle + a single meta line that folds the timestamp and
  // task / story / wave totals together. The Wave Summary table next
  // breaks the totals down per wave, so a hero progress block here would
  // just echo the same numbers a third time.
  lines.push(`# 📋 Dispatch Manifest — Epic #${epicId}`);
  lines.push('');
  lines.push(`> **${epicTitle}**`);
  lines.push('');
  const waveCount = progress.storyWaveCount;
  lines.push(
    `_Generated ${generatedAt} · ${summary.doneTasks}/${summary.totalTasks} tasks · ${progress.doneStories}/${progress.totalStories} stories · ${waveCount} wave${waveCount === 1 ? '' : 's'}_`,
  );
  lines.push('');

  // Top <details> block: operating procedures + full symbol legend. Sits
  // directly under the meta line so an operator opening the manifest
  // sees the run instructions and the symbol key before scrolling.
  lines.push(renderProceduresAndLegendDetails(epicId));
  lines.push('');

  // Wave Summary table (Stories only — Features are containers).
  const allItems =
    manifest.storyManifest ||
    manifest.stories ||
    manifest.summary?.stories ||
    [];
  const waveEligible = allItems.filter((s) => s.type !== 'feature');
  const waveBlock = renderWaveSections(waveEligible);
  if (waveBlock) lines.push(waveBlock);

  // Per-wave H2 sections nesting Stories (H3) and Tasks (checkbox lists).
  if (storyManifest && storyManifest.length > 0) {
    const nestedBlock = renderNestedWaveSections(storyManifest);
    if (nestedBlock) lines.push(nestedBlock);
  }

  /* node:coverage ignore next */
  if (manifest.agentTelemetry) {
    lines.push('## 📈 Agent Telemetry & Diagnostics');
    lines.push('');
    lines.push(
      `- **Total Friction Events:** ${manifest.agentTelemetry.totalFriction}`,
    );
    if (manifest.agentTelemetry.recentFriction.length > 0) {
      lines.push('- **Active Issues & Friction:**');
      for (const item of manifest.agentTelemetry.recentFriction) {
        const safeMessage = item.message
          .replace(/\s+/g, ' ')
          .replace(/\n/g, ' ')
          .trim();
        lines.push(`  - Task **#${item.taskId}**: ${safeMessage}`);
      }
    } else {
      lines.push('- **Active Issues:** None recorded.');
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// Backward-compat alias (existing callers and tests import this name).
export const renderManifestMarkdown = formatManifestMarkdown;

// ---------------------------------------------------------------------------
// Dual entry points: fromManifest / fromSpec (Epic #1182 Story #1501)
//
// `fromManifest` is the canonical-by-name alias for
// `formatManifestMarkdown` — the legacy entry point that consumes a
// fully-resolved dispatch manifest (GH issue numbers, agent::* statuses,
// summary totals) and emits Markdown. Preserved unchanged for non-spec
// callers (the dispatcher's pre-Story #1501 path, every existing test,
// the manifest-renderer facade).
//
// `fromSpec` is the new entry point that takes a structural spec plus a
// state mapping, projects a manifest-shaped object via
// `manifest-builder.js`, then funnels it back through
// `formatManifestMarkdown`. Funnelling — rather than open-coding the
// Markdown emit a second time — is the round-trip byte-identity
// guarantee: any drift in the renderer affects both entry points equally.
// ---------------------------------------------------------------------------

/**
 * Canonical alias for `formatManifestMarkdown`. Existing callers should
 * migrate to this name; the underlying function is unchanged.
 */
export const fromManifest = formatManifestMarkdown;

/**
 * Render a Markdown dispatch manifest from a structural spec. Funnels
 * through `formatManifestMarkdown` so the output is byte-identical to
 * `fromManifest` when given an equivalent manifest fixture (round-trip
 * parity AC for Story #1501).
 *
 * @param {object} spec — parsed epic-spec.
 * @param {Parameters<typeof buildManifestFromSpec>[1]} [opts]
 * @returns {string}
 */
export function fromSpec(spec, opts = {}) {
  const manifest = buildManifestFromSpec(spec, opts);
  // Bust the cache so callers toggling fromSpec / fromManifest in the
  // same process don't get a stale render from a content-hash collision
  // on a different manifest instance.
  __resetManifestFormatterCache();
  return formatManifestMarkdown(manifest);
}
