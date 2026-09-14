/**
 * wave-collision-gate.js — the split gate (Story #5332).
 *
 * Kept out of `wave-serialisation.js` because it answers a different
 * question. That module *predicts* what the dispatcher will do with a draft
 * and renders the prediction as a receipt; this one decides whether the draft
 * may be created at all, and so owns both the one enumeration the refusal and
 * the receipt share and the shape reconciliation that enumeration needs.
 *
 * @module lib/orchestration/plan-persist/wave-collision-gate
 */

import { predictWaveSerialisation } from './wave-serialisation.js';

/**
 * Expose an assembled Story's declared footprint where `storyFootprint`
 * looks for it.
 *
 * `assemblePlanStories` returns the persisted artifact — `{ slug, title,
 * body, bodyObject, acceptance, depends_on, … }` — and carries the parsed
 * `changes[]` inside `bodyObject`, not at the top level. `storyFootprint`
 * reads `files` / `changes` / `changeset` only, so from Story #5313 (which
 * retired the body scrape that had been widening the footprint out of the
 * markdown) until this Story the production call saw an empty footprint for
 * every assembled Story and predicted nothing — the unit fixtures passed a
 * top-level `changes` and so could not show it. The prediction is now the
 * split gate, and a gate that cannot see a declaration cannot fire, so the
 * shapes are reconciled here rather than by widening the dispatcher's own
 * predicate: the runtime's records (`resolve-stories.js`) already carry
 * `changes` at the top level and pass through untouched.
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
 * Render one refused pair as a report line.
 *
 * @param {{ wave: number, slugs: [string, string], paths: string[], source: string }} collision
 * @returns {string}
 */
function formatCollision({ wave, slugs, paths, source }) {
  const declared = paths.map((p) => `\`${p}\``).join(', ');
  return `  - wave ${wave}: "${slugs[0]}" + "${slugs[1]}" both declare ${declared} (${source})`;
}

/**
 * Compute the same-wave collisions of a draft and refuse an N>1 draft that
 * has any — the split gate.
 *
 * ADR `20260912-5312` deleted every numeric plan-time ceiling and left the
 * default-single policy enforced by prose plus `assertAcceptancePartition`,
 * which refused only byte-identical acceptance text across siblings — a shape
 * model output does not produce. The measured result was a plan of 18 Stories
 * whose own summary comment recorded 39 shared files across 14 same-wave
 * Stories: the plan refuted its own parallelism claim, after persist, with
 * nothing acting on it.
 *
 * So the gate is the dispatcher's own predicate rather than a proxy for it. A
 * pair {@link predictWaveSerialisation} names is a pair
 * `stories-wave-tick.js` will refuse to co-dispatch, so the split buys no
 * parallelism while still paying a delivery session per Story. Two remedies,
 * both the author's to take before anything is created: merge the pair into
 * the one Story it already is, or order it with `depends_on` so the members
 * land in different waves.
 *
 * **N=1 can never trip it.** A single-Story draft has no pair to score, so
 * the prediction is empty by construction.
 *
 * The computed collisions are **returned** so the caller hands the same value
 * to the plan-summary receipt instead of recomputing it — a recomputation is
 * how the refusal and the receipt would come to disagree.
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
