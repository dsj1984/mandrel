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
 */

/**
 * Pure: project a full dispatch manifest into the `{ stories }` shape
 * `renderManifest` accepts. Returns the canonical, non-feature,
 * non-ungrouped story rows used by the Epic-level dispatch-manifest
 * comment.
 *
 * @param {object} manifest
 * @returns {{ storyId: number|string, wave: number, title: string }[]}
 */
export function projectStoriesFromManifest(manifest) {
  const storyManifest = manifest?.storyManifest ?? [];
  return storyManifest
    .filter((s) => s && s.type !== 'feature' && s.storyId !== '__ungrouped__')
    .map((s) => ({
      storyId: s.storyId,
      wave: s.earliestWave ?? -1,
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
    'Source of truth for the wave-completeness gate run at `/epic-deliver`.',
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
