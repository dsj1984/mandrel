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

import {
  detectCollision,
  OVERLAP_SOURCES,
  renderScrapeAttribution,
} from '../../wave-runner/footprint.js';

/**
 * Predict which same-wave pairs the dispatch guard will actually refuse to
 * co-dispatch (Story #5265).
 *
 * The wave table answers a `depends_on` question, and the runtime answers a
 * different one: `stories-wave-tick.js` withholds on {@link detectCollision},
 * whose footprint is the declared `changes[]` **plus** every path scraped out
 * of the Story's title, spec and serialized body — and that body carries
 * `## Verify`, so two Stories that merely run the same gate script share a
 * path neither will edit. The table therefore promised parallelism the very
 * next tick refused, with nothing anywhere reconciling the two.
 *
 * This runs the runtime's own exported predicate — not a reimplementation of
 * it — pairwise within each wave, so the prediction cannot drift from the
 * behaviour it predicts.
 *
 * @param {ReturnType<typeof buildWaveTable>} waveTable
 * @param {Array<{ slug: string, title?: string, body?: string, spec?: string, changes?: Array }>} stories
 * @param {{ tempRoot?: string }} [options]
 * @returns {Array<{ wave: number, slugs: [string, string], paths: string[], source: string, attribution: object[] }>}
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
 * to run together whatever the reason, including the pairs whose only shared
 * path was scraped out of a `## Verify` line.
 *
 * @param {ReturnType<typeof predictWaveSerialisation>} collisions
 * @returns {string[]}
 */
export function renderPredictedSerialisationLines(collisions) {
  const list = Array.isArray(collisions) ? collisions : [];
  if (list.length === 0) return [];
  const rows = list.map((c) => {
    const scraped = renderScrapeAttribution(c.attribution);
    return `| \`${c.slugs[0]}\` + \`${c.slugs[1]}\` | ${c.paths
      .map((p) => `\`${p}\``)
      .join(', ')} | ${c.source} | ${scraped ? `\`${scraped}\`` : '—'} |`;
  });
  const scrapedOnly = list.filter(
    (c) => c.source === OVERLAP_SOURCES.SCRAPED,
  ).length;
  return [
    '',
    `#### ⚠️ Predicted serialisation (${list.length} same-order pair(s))`,
    '',
    '| Stories | Colliding paths | Overlap source | Scraped from |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '_The dispatcher compares the **evidence-widened** footprint — declared ' +
      '`changes[]` plus every path named in the title, `## Spec` and the rest ' +
      'of the body — so these pairs are shown in one order above but will be ' +
      `dispatched one at a time. ${scrapedOnly} pair(s) collide only on ` +
      'scraped paths; the "Scraped from" column names the field each such ' +
      'path was read out of, so a shared `## Verify` command is ' +
      'distinguishable from a genuine unpredicted edit target. The guard is ' +
      'deliberately not narrowed to `changes[]`: the declaration is a lower ' +
      'bound (Story #4875) and under-serialising is the worse failure._',
  ];
}
