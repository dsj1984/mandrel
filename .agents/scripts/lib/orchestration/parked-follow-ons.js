/**
 * Classify Stories that exist under an Epic but are absent from the frozen
 * dispatch manifest. Two cases:
 *
 *   - "recut"  — the Story carries a `<!-- recut-of: #N -->` marker whose
 *                parent ID matches a manifest entry. These are attributable
 *                to a manifest Story and must be satisfied alongside it.
 *
 *   - "parked" — the Story is genuinely outside the manifest (carved off
 *                mid-sprint, no recut lineage). The operator should explicitly
 *                adopt it into the current Epic or defer it. Surfaced as a
 *                structured comment so `/deliver` has a single checkpoint.
 *
 * Both categories are informational at the wave-completeness gate — they do
 * not fail closure by themselves. The gate continues to enforce that every
 * manifest Story is closed; recuts and parked follow-ons are additional
 * transparency.
 */

import { parseRecutMarker } from './recut.js';

/**
 * Partition Stories under an Epic into manifest, recut, and parked buckets.
 *
 * @param {number[]} manifestStoryIds  IDs present in the dispatch manifest.
 * @param {Array<{ id: number, title?: string, body?: string, state?: string, labels?: string[] }>} storiesUnderEpic
 *   All `type::story` tickets under the Epic.
 * @returns {{
 *   manifest: Array<object>,
 *   recuts: Array<{ storyId: number, parentId: number, title: string, state: string }>,
 *   parked: Array<{ storyId: number, title: string, state: string }>,
 * }}
 */
export function classifyStoriesAgainstManifest(
  manifestStoryIds,
  storiesUnderEpic,
) {
  const manifestSet = new Set(manifestStoryIds.map(Number));
  const manifest = [];
  const recuts = [];
  const parked = [];

  for (const story of storiesUnderEpic) {
    if (manifestSet.has(story.id)) {
      manifest.push(story);
      continue;
    }
    const marker = parseRecutMarker(story.body);
    if (marker && manifestSet.has(marker.parentStoryId)) {
      recuts.push({
        storyId: story.id,
        parentId: marker.parentStoryId,
        title: story.title ?? '',
        state: story.state ?? 'open',
      });
    } else {
      parked.push({
        storyId: story.id,
        title: story.title ?? '',
        state: story.state ?? 'open',
      });
    }
  }

  return { manifest, recuts, parked };
}

/**
 * Render the structured `parked-follow-ons` comment body for an Epic.
 * Idempotent: the same input produces identical output, so repeated upserts
 * don't churn comment revisions.
 *
 * @param {number} epicId
 * @param {ReturnType<typeof classifyStoriesAgainstManifest>} classification
 * @returns {string}
 */
export function renderParkedFollowOnsComment(epicId, classification) {
  const { recuts, parked } = classification;

  const lines = [
    `## 🪝 Parked Follow-Ons & Recuts — Epic #${epicId}`,
    '',
    'Stories created under this Epic that are **not** in the frozen dispatch',
    'manifest. Surfaced here so `/deliver` can gate on them at the',
    'completeness check.',
    '',
    `- **Recuts** (attributable to a manifest Story): ${recuts.length}`,
    `- **Parked follow-ons** (no manifest lineage): ${parked.length}`,
    '',
  ];

  if (recuts.length > 0) {
    lines.push('### Recuts');
    lines.push('');
    lines.push('| Story | Recut-of | State | Title |');
    lines.push('| :--- | :--- | :--- | :--- |');
    for (const r of recuts) {
      lines.push(
        `| #${r.storyId} | #${r.parentId} | ${r.state} | ${r.title} |`,
      );
    }
    lines.push('');
  }

  if (parked.length > 0) {
    lines.push('### Parked Follow-Ons');
    lines.push('');
    lines.push('| Story | State | Title |');
    lines.push('| :--- | :--- | :--- |');
    for (const p of parked) {
      lines.push(`| #${p.storyId} | ${p.state} | ${p.title} |`);
    }
    lines.push('');
    lines.push(
      '> **Action required**: adopt each Story into the current Epic (by',
      '> re-running the dispatcher so the manifest is refreshed), or explicitly',
      '> defer by closing the Story with `state_reason=not_planned`.',
    );
    lines.push('');
  }

  if (recuts.length === 0 && parked.length === 0) {
    lines.push(
      '✅ No out-of-manifest Stories detected — every Story under this Epic is in the dispatch manifest.',
    );
    lines.push('');
  }

  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        recuts: recuts.map((r) => ({
          storyId: r.storyId,
          parentId: r.parentId,
          state: r.state,
        })),
        parked: parked.map((p) => ({ storyId: p.storyId, state: p.state })),
      },
      null,
      2,
    ),
  );
  lines.push('```');

  return lines.join('\n');
}
