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
  deriveStorySymbol,
  deriveWaveStatus,
  waveHeadingText,
} from './manifest-helpers.js';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Compute per-Story aggregates for the nested wave layout: a 0..100
 * progress percent and the done/total task counts. Pure.
 *
 * @param {{ tasks?: Array<{ status?: string }> }} story
 * @returns {{ pct: number, done: number, total: number }}
 */
function computeStoryProgress(story) {
  const tasks = story?.tasks ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { pct, done, total };
}

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
      waveStats.set(w, { stories: 0, total: 0, done: 0 });
    }
    waveGroups.get(w).push(story);
    const stat = waveStats.get(w);
    stat.stories++;
    stat.total += story.tasks.length;
    stat.done += story.tasks.filter(
      (t) => t.status === AGENT_LABELS.DONE,
    ).length;
  }
  return { waveGroups, waveStats };
}

/**
 * Render the inline body shown under one Story H3. Under the 3-tier
 * hierarchy (Epic #3163) Stories are leaves — they have no child Task
 * tickets, so the renderer surfaces a single marker rather than the
 * legacy per-Task checkbox list. The marker is intentionally identical
 * to the empty-tasks fallback so the layout stays stable when a sibling
 * producer transitions from emitting `tasks: []` to omitting the field
 * entirely.
 *
 * @returns {string[]} lines
 */
function renderStoryTaskList() {
  return ['_(no tasks)_'];
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
      `> ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} · ${stat.done}/${stat.total} tasks${tail}`,
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
      const tasksList = renderStoryTaskList();
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

/**
 * Render the "Concurrency hazards" block that sits at the foot of the
 * dispatch manifest. Consumes the structured findings array emitted by
 * `computeConflictFindings` (Story #2296):
 *
 *   - `shared-editor` findings — one bullet per path with the conflicting
 *     Story identifiers and a `depends_on` remediation hint.
 *   - `implicit-cross-story-dep` findings — one bullet per missing dep
 *     with the producer/consumer pair and a `depends_on` remediation hint.
 *
 * When `findings` is empty the renderer emits a single-line confirmation
 * (`✓ No concurrency hazards detected.`) so absence is explicit in the
 * dry-run log rather than silently dropped.
 *
 * Story identifiers are rendered verbatim — the validator carries planning
 * slugs (e.g. `s-foo`) while persisted findings carry GitHub issue numbers
 * (e.g. `201`). The renderer is agnostic; whichever identifier the caller
 * passes is what shows up.
 *
 * @param {object[]} findings
 * @returns {string} Markdown block, or empty string when `findings` is
 *                   neither an array nor undefined (defensive no-op).
 */
export function renderConcurrencyHazards(findings) {
  if (findings === undefined || findings === null) return '';
  if (!Array.isArray(findings)) return '';
  const lines = ['## ⚠️ Concurrency Hazards', ''];
  if (findings.length === 0) {
    lines.push('✓ No concurrency hazards detected.');
    lines.push('');
    return lines.join('\n');
  }
  const sharedEditors = findings.filter((f) => f?.kind === 'shared-editor');
  const implicit = findings.filter(
    (f) => f?.kind === 'implicit-cross-story-dep',
  );
  for (const f of sharedEditors.sort((a, b) =>
    (a.path ?? '').localeCompare(b.path ?? ''),
  )) {
    lines.push(...renderSharedEditorBullet(f));
  }
  for (const f of implicit.sort((a, b) =>
    (a.path ?? '').localeCompare(b.path ?? ''),
  )) {
    lines.push(...renderImplicitDepBullet(f));
  }
  lines.push('');
  return lines.join('\n');
}

function renderSharedEditorBullet(finding) {
  const stories = Array.isArray(finding.storySlugs) ? finding.storySlugs : [];
  const storyList = stories.map((s) => `\`${s}\``).join(', ');
  const sev = finding.severity === 'hard' ? ' **(blocking)**' : '';
  return [
    `- **\`${finding.path}\`** — written by ${stories.length} concurrent Stories: ${storyList}${sev}`,
    '  - Recommend serializing via `depends_on` chains or a dedicated late-wave "wiring" Story.',
  ];
}

function renderImplicitDepBullet(finding) {
  const producer = finding.producer ?? {};
  const consumer = finding.consumer ?? {};
  const sev = finding.severity === 'hard' ? ' **(blocking)**' : '';
  return [
    `- **\`${finding.path}\`** — produced by Story \`${producer.storySlug ?? '?'}\` (Task \`${producer.taskSlug ?? '?'}\`), consumed by Story \`${consumer.storySlug ?? '?'}\` (Task \`${consumer.taskSlug ?? '?'}\`, \`body.${consumer.sourceField ?? '?'}\`)${sev}`,
    `  - Recommend: add \`depends_on: ["${producer.storySlug ?? '?'}"]\` to the consumer Story.`,
  ];
}

// Test-only: surface the private predicate so the sibling unit test can
// exercise each branch without going through the full renderer.
export const __testables = { validateWaveSection };
