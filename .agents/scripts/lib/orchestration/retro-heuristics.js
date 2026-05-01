/**
 * Heuristics that drive which retro path the `epic-retro` helper composes.
 *
 * The compact three-section retro fires when the Epic's dispatch manifest
 * carries zero friction signals. Non-zero on any of the five dimensions
 * routes back to the full six-section retro. Keeping the predicate here
 * (pure, no I/O) guards the clean-sprint definition from drifting as the
 * retro helper markdown evolves.
 */

/**
 * Evaluate whether an Epic's dispatch manifest counts qualify for the
 * compact retro path.
 *
 * All five signals must be zero. Any non-zero value (including negatives,
 * which are invalid but treated defensively as "non-clean") returns false.
 * Non-number inputs are treated as missing and default to zero so callers
 * can omit dimensions they have not yet gathered — a call with no arguments
 * returns true.
 *
 * @param {Object} [counts]
 * @param {number} [counts.friction=0]  Count of `friction` structured comments on the Epic's descendants.
 * @param {number} [counts.parked=0]    Count of parked follow-on Stories (no manifest lineage).
 * @param {number} [counts.recuts=0]    Count of Stories carrying a `<!-- recut-of: #N -->` marker.
 * @param {number} [counts.hotfixes=0]  Count of Tasks that flipped to `status::blocked` mid-sprint.
 * @param {number} [counts.hitl=0]      Count of tickets that raised an `agent::blocked` event mid-sprint (the runtime HITL pause point).
 * @returns {boolean}
 */
export function isCleanManifest(counts = {}) {
  const { friction, parked, recuts, hotfixes, hitl } = counts;
  return (
    normalize(friction) === 0 &&
    normalize(parked) === 0 &&
    normalize(recuts) === 0 &&
    normalize(hotfixes) === 0 &&
    normalize(hitl) === 0
  );
}

function normalize(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value;
}
