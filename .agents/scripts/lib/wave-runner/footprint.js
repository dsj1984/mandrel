/**
 * lib/wave-runner/footprint.js — what a Story is going to touch, and what two
 * Stories would touch in common.
 *
 * Split out of `ready-set.js` (Story #5044), which is the *scheduling* kernel:
 * eligibility, capacity, admission order. Deciding whether two Stories collide
 * is a separate question with its own rules — what counts as a declaration and
 * what a glob means — and it had grown large enough inside the scheduler to
 * obscure both.
 *
 * ## The footprint is the declaration (Story #5313)
 *
 * Between Story #4875 and Story #5313 the footprint compared here was the
 * declared `changes[]` **widened** by every repo-relative path scraped out of
 * the Story's title, spec and body, on the theory that a declaration is a
 * lower bound. Measured against real cohorts the widening manufactured far
 * more serialisation than it prevented: audit provenance footers, markdown
 * citations, `## Verify` gate commands and `## Non-Goals` prose all read as
 * edit intent, and three narrowing passes (#5044, #5265) were spent teaching
 * the scrape what a path is not. The delivery diet removes the scrape: two
 * Stories collide only when **both declare** a path (or one declares a glob),
 * so the `scraped-overlap` class, the per-path attribution and the field
 * labels are gone with it. What a Story edits beyond its declaration is the
 * close-time merge's business, not a dispatch guess.
 *
 * The layer has exactly one job: given two Story records, say whether their
 * declared footprints intersect and name the paths. It reads nothing and
 * mutates nothing.
 *
 * @module lib/wave-runner/footprint
 */

/**
 * Why two footprints collided. Since Story #5313 there is exactly one class:
 * a path both Stories declared (or a declared glob). The value is kept on the
 * envelope so a consumer keyed on `source` does not have to learn a new
 * vocabulary, and so a future second class has a home.
 */
export const OVERLAP_SOURCES = Object.freeze({
  DECLARED: 'declared-overlap',
});

/**
 * Extract a Story's declared file footprint as a normalized set of path
 * strings. Accepts the three footprint shapes a Story record can carry:
 *
 *   - `files: string[]`                         — explicit footprint.
 *   - `changes: string[]`                       — string-array sketch.
 *   - `changeset: Array<{ path }>` /            — object-array sketch (the
 *     `changes: Array<{ path }>`                   `{ path, assumption }`
 *                                                  shape from a Story body).
 *
 * Paths are trimmed; empty / non-string entries are dropped. A Story with
 * no declared footprint yields an empty set, which (by {@link detectCollision}'s
 * contract) means it overlaps with nothing and is never withheld.
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
 * Does a declared path contain a glob metacharacter? Mirrors the detection
 * in `story-body.js#extractChangePaths`, whose `isGlob` flag documents an
 * "unknown-width footprint" policy that was never implemented downstream.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isGlobPath(path) {
  return path.includes('*') || path.includes('?') || path.includes('{');
}

/**
 * Collect the glob paths on one side. A glob is unknown width, and unknown
 * width is not no width: within a beat it collides with everything, because
 * exact-string comparison would silently pass a Story declaring
 * `.agents/scripts/lib/**` alongside one declaring a file underneath it
 * (Story #4539/#4540).
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
 * The colliding paths between two Stories' declared footprints — or `null`
 * when they do not collide.
 *
 * **An empty footprint means "no known overlap"**, so this short-circuits to
 * `null` on one. That is permissive by necessity: a Story with no declared
 * footprint carries no information, and withholding on absence would
 * serialize every run.
 *
 * `concreteOnly` selects between the two guards' deliberately different
 * treatment of unknown width (Story #4960). The beat-local guard counts a glob
 * on either side as colliding with everything; the cross-beat reservation
 * ignores globs entirely, because an in-flight Story holds its footprint for a
 * whole implementation window and one glob would otherwise withhold the entire
 * run for hours — and `resolve-stories.js` substitutes an UNKNOWN sentinel for
 * any body it cannot parse, so one malformed Story would make a run serial.
 *
 * The second options parameter is accepted for call-site compatibility with
 * the retired evidence-scrape options (`tempRoot`); only `concreteOnly` is
 * read.
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
