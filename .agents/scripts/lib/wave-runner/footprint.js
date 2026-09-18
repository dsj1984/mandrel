/**
 * lib/wave-runner/footprint.js — whether two Stories' declared footprints
 * intersect. The footprint is the declaration only: paths scraped from
 * titles, specs or prose manufactured far more serialisation than they
 * prevented, so two Stories collide only when both declare a path (or one
 * declares a glob). Reads and mutates nothing.
 *
 * @module lib/wave-runner/footprint
 */

/**
 * One class today; kept on the envelope so consumers keyed on `source` stay
 * stable if a second class appears.
 */
export const OVERLAP_SOURCES = Object.freeze({
  DECLARED: 'declared-overlap',
});

/**
 * Union of `files`, `changes` and `changeset` (strings or `{ path }`),
 * trimmed. An empty set overlaps nothing.
 *
 * @param {object} story
 * @returns {Set<string>}
 */
export function storyFootprint(story) {
  const out = new Set();
  const push = (entry) => {
    const path =
      typeof entry === 'string'
        ? entry
        : typeof entry?.path === 'string'
          ? entry.path
          : null;
    const trimmed = path?.trim();
    if (trimmed) out.add(trimmed);
  };
  for (const shape of [story?.files, story?.changes, story?.changeset]) {
    if (Array.isArray(shape)) for (const entry of shape) push(entry);
  }
  return out;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isGlobPath(path) {
  return path.includes('*') || path.includes('?') || path.includes('{');
}

/**
 * A glob is unknown width, not no width: exact-string comparison would pass
 * `lib/**` alongside a file beneath it, so a glob collides with everything.
 *
 * @param {Set<string>} hits
 * @param {Set<string>} side
 */
function collectGlobs(hits, side) {
  for (const path of side) {
    if (isGlobPath(path)) hits.add(path);
  }
}

/**
 * Colliding paths, or `null`. An empty footprint never collides —
 * withholding on absence would serialize every run.
 *
 * `concreteOnly` is for the cross-beat reservation: an in-flight Story holds
 * its footprint for hours, and unparseable bodies resolve to an UNKNOWN glob
 * sentinel, so honouring globs there would make one bad Story serialize the
 * whole run. The beat-local guard honours globs.
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [options]
 * @param {boolean} [options.concreteOnly=false] Skip glob paths on both sides.
 * @returns {{ paths: string[], source: string }|null}
 */
export function detectCollision(a, b, { concreteOnly = false } = {}) {
  const fa = storyFootprint(a);
  if (fa.size === 0) return null;
  const fb = storyFootprint(b);
  if (fb.size === 0) return null;

  const hits = new Set();
  for (const path of fa) {
    if (!isGlobPath(path) && fb.has(path)) hits.add(path);
  }
  if (!concreteOnly) {
    collectGlobs(hits, fa);
    collectGlobs(hits, fb);
  }
  if (hits.size === 0) return null;
  return { paths: [...hits].sort(), source: OVERLAP_SOURCES.DECLARED };
}
