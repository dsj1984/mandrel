/**
 * wave-collision-gate.js — the split gate: decides whether an N>1 draft may
 * be created at all, where `wave-serialisation.js` only predicts.
 *
 * @module lib/orchestration/plan-persist/wave-collision-gate
 */

import { predictWaveSerialisation } from './wave-serialisation.js';

/**
 * Assembled Stories carry `changes[]` inside `bodyObject`, but
 * `storyFootprint` reads only top-level `files`/`changes`/`changeset` — lift
 * it, or the gate sees an empty footprint and can never fire.
 *
 * @param {object} story
 * @returns {object} The same record, with a top-level `changes` when one can
 *   be resolved from its `bodyObject`.
 */
function withDeclaredFootprint(story) {
  if (!story || typeof story !== 'object') return story;
  const declared = [story.files, story.changes, story.changeset].some(
    (shape) => Array.isArray(shape) && shape.length > 0,
  );
  if (declared) return story;
  const fromBody = story.bodyObject?.changes;
  return Array.isArray(fromBody) ? { ...story, changes: fromBody } : story;
}

/**
 * @param {{ wave: number, slugs: [string, string], paths: string[], source: string }} collision
 * @returns {string}
 */
function formatCollision({ wave, slugs, paths, source }) {
  const declared = paths.map((p) => `\`${p}\``).join(', ');
  return `  - wave ${wave}: "${slugs[0]}" + "${slugs[1]}" both declare ${declared} (${source})`;
}

/**
 * Refuse an N>1 draft with any same-wave collision. The gate is the
 * dispatcher's own predicate: a pair it names will never co-dispatch, so the
 * split buys no parallelism. Collisions are returned so the summary receipt
 * reuses them rather than recomputing (and disagreeing).
 *
 * @param {ReturnType<typeof import('./summary.js').buildWaveTable>} waveTable
 * @param {Array<object>} stories The assembled Stories, in draft order.
 * @param {{ tempRoot?: string }} [options] Threaded to the predicate.
 * @returns {ReturnType<typeof predictWaveSerialisation>}
 * @throws {Error} When an N>1 draft has at least one colliding same-wave pair.
 */
export function assertNoWaveCollisions(waveTable, stories, options = {}) {
  const list = Array.isArray(stories) ? stories : [];
  const collisions = predictWaveSerialisation(
    waveTable,
    list.map(withDeclaredFootprint),
    options,
  );
  if (list.length <= 1 || collisions.length === 0) return collisions;
  throw new Error(
    `[plan-persist] ${collisions.length} same-wave collision(s) — the ` +
      'dispatcher will refuse to co-dispatch these pairs, so the split buys ' +
      'no parallelism and costs a delivery session per Story:\n' +
      `${collisions.map(formatCollision).join('\n')}\n` +
      'Remedy: merge each pair into the one Story it already is (its stages ' +
      'belong in `## Slicing`), or order the pair with `depends_on` so the ' +
      'members sit in different waves.',
  );
}
