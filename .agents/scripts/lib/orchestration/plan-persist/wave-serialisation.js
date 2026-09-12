/**
 * wave-serialisation.js — what the dispatcher will actually do with the wave
 * table plan-persist prints (Story #5265).
 *
 * Kept out of `summary.js` because it answers a different question. The
 * summary module renders receipts persist already computed; this one runs the
 * *runtime's* collision predicate over the assembled Story bodies to work out
 * which of the table's promises the next tick will refuse to keep.
 *
 * @module lib/orchestration/plan-persist/wave-serialisation
 */

import { detectCollision } from '../../wave-runner/footprint.js';

/**
 * Predict which same-wave pairs the dispatch guard will actually refuse to
 * co-dispatch (Story #5265).
 *
 * The wave table answers a `depends_on` question, and the runtime answers a
 * different one: `stories-wave-tick.js` withholds on {@link detectCollision}
 * over the declared `changes[]` (Story #5313 retired the text scrape), so
 * two same-wave Stories that both declare a path — a shared generated
 * baseline, say — are shown in one order and dispatched one at a time. The
 * table promised parallelism the next tick refused, with nothing anywhere
 * reconciling the two.
 *
 * This runs the runtime's own exported predicate — not a reimplementation of
 * it — pairwise within each wave, so the prediction cannot drift from the
 * behaviour it predicts.
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
 * Render the predicted serialisation beside the wave table (Story #5265).
 *
 * Same shape as {@link renderSharedEditorLines} on purpose: both are caveats
 * against the same promise, and an operator should read them the same way.
 * The difference is what they know — the shared-editor pass names paths two
 * Stories both *write*, this one names every pair the dispatcher will refuse
 * to run together, glob declarations included.
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
