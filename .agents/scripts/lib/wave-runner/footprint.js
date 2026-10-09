/**
 * lib/wave-runner/footprint.js — whether two Stories' declared footprints
 * intersect. The footprint is the declaration only: paths scraped from
 * titles, specs or prose manufactured far more serialisation than they
 * prevented, so two Stories collide only when both declare a path, one
 * declares a glob covering the other's path, or both declare globs whose
 * static bases overlap. Reads and mutates nothing.
 *
 * @module lib/wave-runner/footprint
 */

import picomatch from 'picomatch';

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
export function isGlobPath(path) {
  return path.includes('*') || path.includes('?') || path.includes('{');
}

const GLOB_OPTIONS = Object.freeze({ dot: true });

/**
 * The glob's static directory prefix — `''` for a glob such as `**` or
 * `*.md` that is rooted nowhere.
 *
 * @param {string} glob
 * @returns {string}
 */
function globBase(glob) {
  return picomatch.scan(glob).base;
}

/**
 * Whole-segment prefix overlap: `lib` covers `lib/x`, never `libs`. An empty
 * base overlaps everything.
 *
 * @param {string} x
 * @param {string} y
 * @returns {boolean}
 */
function basesOverlap(x, y) {
  if (x === '' || y === '' || x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(`${short}/`);
}

/**
 * Whether two globs may match a common path, judged by their static bases.
 * Conservative by design: two globs sharing a base may still be disjoint
 * (`lib/*.js` vs `lib/*.md`), and the predicate serializes them anyway.
 *
 * @param {string} g
 * @param {string} h
 * @returns {boolean}
 */
export function globsOverlap(g, h) {
  return basesOverlap(globBase(g), globBase(h));
}

/**
 * Record that `side` declared `path` as a colliding path.
 *
 * @param {Map<string, Set<string>>} hits
 * @param {string} path
 * @param {'a'|'b'} side
 */
function addHit(hits, path, side) {
  const sides = hits.get(path) ?? new Set();
  sides.add(side);
  hits.set(path, sides);
}

/**
 * Collect the globs on `globSide` that cover a concrete path or overlap a
 * glob on `otherSide`. A glob hit reports the glob — the thing an author
 * edits — never the concrete path it matched.
 *
 * @param {Map<string, Set<string>>} hits
 * @param {{ globs: string[], concrete: string[] }} mine
 * @param {{ globs: string[], concrete: string[] }} theirs
 * @param {'a'|'b'} side
 */
function collectGlobHits(hits, mine, theirs, side) {
  for (const glob of mine.globs) {
    const matches = picomatch(glob, GLOB_OPTIONS);
    const covers =
      theirs.concrete.some((path) => matches(path)) ||
      theirs.globs.some((other) => globsOverlap(glob, other));
    if (covers) addHit(hits, glob, side);
  }
}

/**
 * @param {Set<string>} footprint
 * @returns {{ globs: string[], concrete: string[] }}
 */
function partition(footprint) {
  const globs = [];
  const concrete = [];
  for (const path of footprint)
    (isGlobPath(path) ? globs : concrete).push(path);
  return { globs, concrete };
}

/**
 * Colliding paths, or `null`. An empty footprint never collides —
 * withholding on absence would serialize every run.
 *
 * Two footprints collide on a concrete path both declare, on a glob that
 * matches a concrete path the other side declares, or on two globs whose
 * static bases overlap. The `**` UNKNOWN sentinel therefore collides with
 * every non-empty footprint by construction: it matches every concrete path
 * and its empty base overlaps every glob.
 *
 * `concreteOnly` is for the cross-beat reservation: an in-flight Story holds
 * its footprint for hours, and unparseable bodies resolve to an UNKNOWN glob
 * sentinel, so honouring globs there would make one bad Story serialize the
 * whole run. The beat-local guard honours globs.
 *
 * `declaredBy` maps each colliding path to the side that declared it —
 * `'a'`, `'b'` or `'both'` — so a refusal can name its declarer.
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [options]
 * @param {boolean} [options.concreteOnly=false] Skip glob paths on both sides.
 * @returns {{ paths: string[], source: string, declaredBy: Record<string, 'a'|'b'|'both'> }|null}
 */
export function detectCollision(a, b, { concreteOnly = false } = {}) {
  const fa = storyFootprint(a);
  if (fa.size === 0) return null;
  const fb = storyFootprint(b);
  if (fb.size === 0) return null;

  const pa = partition(fa);
  const pb = partition(fb);
  /** @type {Map<string, Set<string>>} */
  const hits = new Map();
  for (const path of pa.concrete) {
    if (fb.has(path)) {
      addHit(hits, path, 'a');
      addHit(hits, path, 'b');
    }
  }
  if (!concreteOnly) {
    collectGlobHits(hits, pa, pb, 'a');
    collectGlobHits(hits, pb, pa, 'b');
  }
  if (hits.size === 0) return null;
  const paths = [...hits.keys()].sort();
  const declaredBy = Object.fromEntries(
    paths.map((path) => {
      const sides = hits.get(path);
      return [path, sides.size === 2 ? 'both' : [...sides][0]];
    }),
  );
  return { paths, source: OVERLAP_SOURCES.DECLARED, declaredBy };
}
