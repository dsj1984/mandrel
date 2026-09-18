/**
 * wave-serialisation.js — predicts which of the wave table's parallelism
 * promises the dispatcher will refuse to keep.
 *
 * @module lib/orchestration/plan-persist/wave-serialisation
 */

import { detectCollision } from '../../wave-runner/footprint.js';

/**
 * Same-wave pairs the dispatch guard will refuse to co-dispatch, computed by
 * running the runtime's own {@link detectCollision} pairwise — never a
 * reimplementation — so the prediction cannot drift from the behaviour.
 *
 * @param {ReturnType<typeof buildWaveTable>} waveTable
 * @param {Array<{ slug: string, title?: string, body?: string, spec?: string, changes?: Array }>} stories
 * @param {{ tempRoot?: string }} [options] Accepted for compatibility; unread.
 * @returns {Array<{ wave: number, slugs: [string, string], paths: string[], source: string }>}
 */
export function predictWaveSerialisation(waveTable, stories, options = {}) {
  const bySlug = new Map(
    (Array.isArray(stories) ? stories : []).map((s) => [s.slug, s]),
  );
  const out = [];
  for (const { wave, stories: members } of Array.isArray(waveTable)
    ? waveTable
    : []) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = bySlug.get(members[i].slug);
        const b = bySlug.get(members[j].slug);
        if (!a || !b) continue;
        const collision = detectCollision(a, b, options);
        if (collision) {
          out.push({
            wave,
            slugs: [members[i].slug, members[j].slug],
            ...collision,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Same shape as {@link renderSharedEditorLines} on purpose: both caveat the
 * same promise.
 *
 * @param {ReturnType<typeof predictWaveSerialisation>} collisions
 * @returns {string[]}
 */
export function renderPredictedSerialisationLines(collisions) {
  const list = Array.isArray(collisions) ? collisions : [];
  if (list.length === 0) return [];
  const rows = list.map(
    (c) =>
      `| \`${c.slugs[0]}\` + \`${c.slugs[1]}\` | ${c.paths
        .map((p) => `\`${p}\``)
        .join(', ')} | ${c.source} |`,
  );
  return [
    '',
    `#### ⚠️ Predicted serialisation (${list.length} same-order pair(s))`,
    '',
    '| Stories | Colliding paths | Overlap source |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '_The dispatcher compares the **declared** `changes[]` footprints ' +
      '(Story #5313 retired the text scrape), so these pairs are shown in ' +
      'one order above but will be dispatched one at a time: both Stories ' +
      'declare a colliding path, or one declares a glob._',
  ];
}
