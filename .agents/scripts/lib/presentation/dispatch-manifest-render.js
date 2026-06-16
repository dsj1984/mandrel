/**
 * dispatch-manifest-render.js — pure helper that renders the
 * `dispatch-manifest` structured-comment body posted on an Epic.
 *
 * Extracted from `manifest-renderer.js::postManifestEpicComment` so the
 * wave-runner's manifest refresh hop can render the same Markdown in
 * process without spawning `dispatcher.js --dry-run`.
 *
 * No top-level side effects — safe to import from tests without
 * triggering GitHub I/O.
 *
 * Story #4157 — each projected story's `wave` is a **render-time
 * dependency depth** derived from the manifest's `dependsOn` edges via the
 * shared `deriveStoryDepths` lens (`manifest-render-waves.js`, built on
 * `assignLayers`), not the persisted `earliestWave`. Scheduling no longer
 * stamps a wave field onto the run checkpoint (Epic #4151 / Story #4155),
 * so the rollup re-derives depth from the dependency graph at render time.
 */

import { deriveStoryDepths } from './manifest-render-waves.js';

/**
 * Pure: project a full dispatch manifest into the `{ stories }` shape
 * `renderManifest` accepts. Returns the canonical, non-ungrouped story
 * rows used by the Epic-level dispatch-manifest comment.
 *
 * The `wave` field is the render-time dependency depth (Story #4157):
 * `deriveStoryDepths` runs `assignLayers` over the entries' `dependsOn`
 * edges, so a Story with no in-set dependency is wave 0 and a dependent
 * sits one layer deeper than its deepest dependency. Entries the lens
 * cannot place (e.g. a non-integer storyId that survives the sentinel
 * filter) fall back to `-1`.
 *
 * @param {object} manifest
 * @returns {{ storyId: number|string, wave: number, title: string }[]}
 */
export function projectStoriesFromManifest(manifest) {
  const storyManifest = manifest?.storyManifest ?? [];
  const depths = deriveStoryDepths(storyManifest);
  return storyManifest
    .filter((s) => s && s.storyId !== '__ungrouped__')
    .map((s) => ({
      storyId: s.storyId,
      wave: depths.get(s.storyId) ?? -1,
      title: s.storyTitle ?? s.storySlug ?? '',
    }));
}

/**
 * Pure: count distinct, non-(-1) wave indexes across `stories`.
 *
 * @param {{ wave: number }[]} stories
 */
export function countWaves(stories) {
  const set = new Set();
  for (const s of stories ?? []) {
    if (s && typeof s.wave === 'number' && s.wave !== -1) set.add(s.wave);
  }
  return set.size;
}

/**
 * Pure: render the dispatch-manifest comment body for an Epic.
 *
 * The output is byte-identical to the body
 * `postManifestEpicComment` historically built inline, so it can be
 * upserted by either the dispatcher (CLI path) or the wave-runner
 * (in-process refresh path) without behavioural drift.
 *
 * @param {{
 *   epicId: number,
 *   stories: { storyId: number|string, wave: number, title: string }[],
 *   generatedAt: string,
 * }} args
 * @returns {string}
 */
export function renderManifest({ epicId, stories, generatedAt }) {
  if (!Number.isFinite(epicId) && typeof epicId !== 'number') {
    throw new TypeError('renderManifest: epicId is required');
  }
  const list = Array.isArray(stories) ? stories : [];
  const waveCount = countWaves(list);
  return [
    `## 📋 Dispatch Manifest — Epic #${epicId}`,
    '',
    `- **Waves:** ${waveCount || 1}`,
    `- **Stories:** ${list.length}`,
    `- **Generated:** ${generatedAt}`,
    '',
    'Source of truth for the wave-completeness gate run at `/deliver`.',
    '',
    '```json',
    JSON.stringify({ stories: list }, null, 2),
    '```',
  ].join('\n');
}

/**
 * Convenience: render directly from a full manifest object. Equivalent
 * to `renderManifest({ epicId, stories: projectStoriesFromManifest(m),
 * generatedAt: m.generatedAt })`.
 *
 * @param {object} manifest
 */
export function renderManifestFromManifest(manifest) {
  return renderManifest({
    epicId: manifest?.epicId,
    stories: projectStoriesFromManifest(manifest),
    generatedAt: manifest?.generatedAt,
  });
}
