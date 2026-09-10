/**
 * lib/wave-runner/footprint.js — what a Story is going to touch, and what two
 * Stories would touch in common.
 *
 * Split out of `ready-set.js` (Story #5044), which is the *scheduling* kernel:
 * eligibility, capacity, admission order. Deciding whether two Stories collide
 * is a separate question with its own rules — what counts as a declaration,
 * what counts as evidence, what a glob means, and which text is edit intent
 * rather than machine-generated noise — and it had grown large enough inside
 * the scheduler to obscure both.
 *
 * The layer has exactly one job: given two Story records, say whether their
 * file footprints intersect, name the paths, and say whether a declaration or
 * the text scrape produced the answer. It reads nothing and mutates nothing.
 *
 * @module lib/wave-runner/footprint
 */

/**
 * Why two footprints collided.
 *
 * `declared-overlap` — at least one colliding path was **declared** by both
 * Stories (or is a declared glob). This is the guard doing its intended job:
 * two Stories that both list `baselines/maintainability.json` really do have to
 * be serialized, and no amount of scrape-narrowing should change that.
 *
 * `scraped-overlap` — every colliding path reached the comparison through the
 * evidence widening rather than a declaration. Still a real signal (Story
 * #4875 exists because declarations are systematically a lower bound), but it
 * is the class where a false positive is possible, so it is the one an operator
 * should be able to see and — via `footprintGuard: 'advisory'` — choose not to
 * enforce.
 */
export const OVERLAP_SOURCES = Object.freeze({
  DECLARED: 'declared-overlap',
  SCRAPED: 'scraped-overlap',
});

/**
 * Repo-relative file paths as they appear in Story prose: at least one `/`
 * separator and a short file extension. Deliberately narrow — a token has to
 * look like a real path before it can widen a footprint and withhold a Story.
 */
const PROSE_PATH_RE = /(?:[\w.@~-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}/g;

/**
 * The **machine-generated audit provenance footers** — and nothing else.
 *
 * `/audit-to-stories` and `plan-persist` stamp `<!-- audit-fingerprints: … -->`
 * and `<!-- audit-semantic-keys: … -->` onto a Story body as dedup identity.
 * A semantic key is `area␟primaryFile`, and that `␟` (U+241F) separator is
 * outside {@link PROSE_PATH_RE}'s character class, so the `primaryFile` half
 * matches as a standalone path token. `plan-persist` carries the **sweep-wide
 * union** of those footers onto every sibling of an audit-derived plan, so
 * every pair of that plan shared path-shaped tokens neither Story would edit —
 * measured at 10/10 colliding pairs, 0/10 once these blocks are ignored
 * (issue #5040).
 *
 * **This is surgical on purpose: a blanket HTML-comment strip would be wrong.**
 * `.agents/instructions.md` § 7 puts a complexity decomposition's numbered
 * sub-steps inside a `<!-- DECOMPOSITION -->` block, and the paths a sub-step
 * names are exactly the edit intent this layer exists to read. Only the two
 * provenance markers below are removed; every other comment stays evidence.
 */
const PROVENANCE_FOOTER_RE =
  /<!--\s*audit-(?:fingerprints|semantic-keys)\s*:[\s\S]*?-->/g;

/**
 * The URL interior of a markdown inline link (`](…)`), with an optional title.
 * A link target is a *citation* — "see [the spec](docs/architecture.md)" — not
 * a declaration that this Story will edit that file, and generated bodies cite
 * the same source report from every sibling. The link **text** is left intact:
 * a human writing "the caller in [`bin/mandrel.js`](bin/mandrel.js)" is naming
 * an edit target in the prose half, and that half still counts.
 */
const MARKDOWN_LINK_URL_RE = /\]\(\s*[^)\s]*(?:\s+"[^"]*")?\s*\)/g;

/** Default gitignored scratch root when no `project.paths.tempRoot` is threaded. */
const DEFAULT_TEMP_ROOT = 'temp';

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
 * Is this path inside the gitignored temp root?
 *
 * `project.paths.tempRoot` is scratch space by contract
 * ([`.agents/instructions.md`](../../../instructions.md) § 6): nothing under it
 * is ever committed, so it can never be a delivery write target, and two
 * Stories naming the same `temp/audits/audit-<lens>-results.md` source report
 * are not racing anything. The match is rooted, not a substring test, so a real
 * deliverable like `lib/temperature.js` is untouched.
 *
 * @param {string} path
 * @param {string} tempRoot
 * @returns {boolean}
 */
function isUnderTempRoot(path, tempRoot) {
  if (!tempRoot) return false;
  const normalized = path.replace(/^\.\//, '');
  return normalized === tempRoot || normalized.startsWith(`${tempRoot}/`);
}

/**
 * Scrape file paths a Story's **text** mentions but its `changes[]` never
 * declared (Story #4875), **narrowed to text that expresses edit intent**
 * (Story #5044).
 *
 * The declared footprint is a planner's *prediction*, and it is systematically
 * a lower bound: a Story's `## Spec` names the module it must also touch, its
 * acceptance criteria name the caller that must be updated, and none of that
 * reaches `changes[]`. The overlap guard exists to stop two Stories racing the
 * same file, so trusting the declaration outright means the guard is blind to
 * precisely the collisions nobody predicted.
 *
 * But the converse failure is just as real: a path-shaped token that no human
 * wrote as intent manufactures a collision, and a manufactured collision
 * serializes a run that had no reason to be serial. Three token sources are
 * therefore excluded before the scrape, each because it is *structurally*
 * incapable of naming an edit target:
 *
 *   1. **Audit provenance footers** ({@link PROVENANCE_FOOTER_RE}) — machine-
 *      stamped dedup identity, unioned sweep-wide across siblings.
 *   2. **Markdown-link URLs** ({@link MARKDOWN_LINK_URL_RE}) — citations.
 *   3. **Paths under the temp root** ({@link isUnderTempRoot}) — gitignored
 *      scratch, never a write target.
 *
 * Evidence is only ever **added** to the declaration — nothing here can shrink
 * a declared footprint, so `changes[]` remains a lower bound (Story #4875) and
 * narrowing the scrape can never co-dispatch a pair the declared comparison
 * would have caught.
 *
 * Each path is returned **with the field it was scraped from** (Story #5265).
 * "This pair collided on a path neither declared" is only half an
 * explanation: the operator's next question is always *where did that path
 * come from*, and until they can answer it they cannot tell an unpredicted
 * edit target from a citation the guard read as one. The measured case is a
 * gate script every Story merely **runs** in `verify[]` — attribution turns
 * that from an unexplained serialisation into a one-glance verdict.
 *
 * @param {object} story
 * @param {object} [options]
 * @param {string} [options.tempRoot='temp'] Resolved `project.paths.tempRoot`.
 * @returns {Map<string, Set<string>>} Path → the field label(s) that named it.
 */
function storyEvidencePaths(story, { tempRoot = DEFAULT_TEMP_ROOT } = {}) {
  const out = new Map();
  for (const [field, text] of attributedSegments(story)) {
    for (const [token] of text.matchAll(PROSE_PATH_RE)) {
      if (isUnderTempRoot(token, tempRoot)) continue;
      const fields = out.get(token);
      if (fields) fields.add(field);
      else out.set(token, new Set([field]));
    }
  }
  return out;
}

/**
 * A markdown section heading in a serialized Story body — the attribution
 * grain (Story #5265).
 *
 * `body` alone would be a true but useless label: a Story body is the whole
 * document, so every scraped path would report the same field. The section is
 * where the distinction actually lives — a path under `## Changes` is a
 * declaration restated, one under `## Verify` is a command line, one under
 * `## Non-Goals` is explicitly *not* an edit target.
 */
const BODY_SECTION_RE = /^#{2,6}[ \t]+(\S.*?)[ \t]*$/gm;

/**
 * Strip the two token sources that are structurally incapable of naming an
 * edit target. Applied to the whole field **before** segmentation, so the
 * scanned text is byte-identical to what the pre-attribution scrape read and
 * a stripped footer can never be mistaken for a section boundary.
 *
 * @param {string} text
 * @returns {string}
 */
function stripNonIntentTokens(text) {
  return text
    .replace(PROVENANCE_FOOTER_RE, ' ')
    .replace(MARKDOWN_LINK_URL_RE, ']()');
}

/**
 * Split a Story body into `[label, text]` segments at its `##` headings.
 *
 * The heading line stays with the section it opens rather than being consumed
 * as a delimiter: a heading can itself name a path, and dropping that text
 * would *narrow* the footprint — the one direction this layer must never move
 * (Story #4875 / #5265 AC-8). Text before the first heading keeps the bare
 * `body` label.
 *
 * @param {string} body
 * @returns {Array<[string, string]>}
 */
function bodySegments(body) {
  const out = [];
  let cursor = 0;
  let label = 'body';
  for (const match of body.matchAll(BODY_SECTION_RE)) {
    if (match.index > cursor)
      out.push([label, body.slice(cursor, match.index)]);
    label = `body:${match[1].trim()}`;
    cursor = match.index;
  }
  out.push([label, body.slice(cursor)]);
  return out;
}

/**
 * Every scannable `[fieldLabel, text]` pair on a Story record: `title` and
 * `spec` whole, `body` split by section.
 *
 * @param {object} story
 * @returns {Array<[string, string]>}
 */
function attributedSegments(story) {
  const out = [];
  if (typeof story?.title === 'string') {
    out.push(['title', stripNonIntentTokens(story.title)]);
  }
  if (typeof story?.body === 'string') {
    out.push(...bodySegments(stripNonIntentTokens(story.body)));
  }
  if (typeof story?.spec === 'string') {
    out.push(['spec', stripNonIntentTokens(story.spec)]);
  }
  return out;
}

/**
 * A Story's declared footprint **and** the evidence-widened one.
 *
 * Both are returned because they answer different questions. `widened` decides
 * *whether* two Stories collide; `declared` decides *how to describe* the
 * collision — a path both Stories declared is intended serialization (two
 * Stories that really do rewrite the same generated baseline), while one only
 * the scrape produced may be an artifact of how a body was worded. An operator
 * reading an unfilled slot needs to tell those apart.
 *
 * `evidence` carries the third answer (Story #5265): *which field* produced
 * each scraped path, so a collision can say where the token was written
 * rather than only that nobody declared it.
 *
 * @param {object} story
 * @param {object} [options]
 * @returns {{ declared: Set<string>, widened: Set<string>, evidence: Map<string, Set<string>> }}
 */
function storyFootprints(story, options) {
  const declared = storyFootprint(story);
  const evidence = storyEvidencePaths(story, options);
  const widened = new Set(declared);
  for (const path of evidence.keys()) widened.add(path);
  return { declared, widened, evidence };
}

/**
 * The field labels that scraped `path` on one side — empty when that side
 * **declared** it, because a declaration is not evidence and reporting the
 * prose restatement of a declared path would read as if the scrape had caused
 * the collision.
 *
 * @param {{ declared: Set<string>, evidence: Map<string, Set<string>> }} side
 * @param {string} path
 * @returns {string[]}
 */
function scrapedFields(side, path) {
  if (side.declared.has(path)) return [];
  return [...(side.evidence.get(path) ?? [])];
}

/**
 * Per-path provenance for one colliding path (Story #5265): whether both
 * sides declared it, and — when at least one side did not — the field labels
 * the scrape found it in, unioned across the two sides and sorted.
 *
 * @param {object} fa
 * @param {object} fb
 * @param {string} path
 * @param {boolean} declared
 * @returns {{ path: string, declared: boolean, fields: string[] }}
 */
function attributePath(fa, fb, path, declared) {
  const fields = new Set([
    ...scrapedFields(fa, path),
    ...scrapedFields(fb, path),
  ]);
  return { path, declared, fields: [...fields].sort() };
}

/**
 * Record one colliding path, remembering whether **any** occurrence of it was
 * declaration-backed.
 *
 * `declared` is tracked per path rather than per pair because the two hit kinds
 * qualify differently: a shared **concrete** path counts as declared only when
 * both sides declared it, whereas a **glob** names no file to share and counts
 * as declared when its own side declared it. The scraper cannot emit a glob —
 * prose globs are narrative ("everything under `.agents/**`") and never match
 * {@link PROSE_PATH_RE} — so a glob hit is essentially always declared width
 * failing safe, and labelling it `scraped` would make advisory mode read as if
 * the text widening had caused it.
 *
 * @param {Map<string, boolean>} hits
 * @param {string} path
 * @param {boolean} declared
 */
function recordHit(hits, path, declared) {
  hits.set(path, (hits.get(path) ?? false) || declared);
}

/**
 * Collect the glob paths on one side. A glob is unknown width, and unknown
 * width is not no width: within a beat it collides with everything, because
 * exact-string comparison would silently pass a Story declaring
 * `.agents/scripts/lib/**` alongside one declaring a file underneath it
 * (Story #4539/#4540).
 *
 * @param {Map<string, boolean>} hits
 * @param {{ declared: Set<string>, widened: Set<string> }} side
 */
function recordGlobs(hits, side) {
  for (const path of side.widened) {
    if (isGlobPath(path)) recordHit(hits, path, side.declared.has(path));
  }
}

/**
 * The colliding paths between two Stories' widened footprints, tagged with
 * whether a declaration produced the collision — or `null` when they do not
 * collide.
 *
 * **An empty footprint means "no known overlap"**, so this short-circuits to
 * `null` on one. That is permissive by necessity: a Story with no declared
 * footprint and no path evidence in its text carries no information, and
 * withholding on absence would serialize every run.
 *
 * `concreteOnly` selects between the two guards' deliberately different
 * treatment of unknown width (Story #4960). The beat-local guard counts a glob
 * on either side as colliding with everything; the cross-beat reservation
 * ignores globs entirely, because an in-flight Story holds its footprint for a
 * whole implementation window and one glob would otherwise withhold the entire
 * run for hours — and `resolve-stories.js` substitutes an UNKNOWN sentinel for
 * any body it cannot parse, so one malformed Story would make a run serial.
 *
 * `attribution` (Story #5265) reports the same `paths`, one entry each, with
 * the provenance a consumer needs to explain the withhold: `declared` says
 * whether both sides named the path in `changes[]`, and `fields` names the
 * field label(s) the scrape read it from otherwise (`title`, `spec`, or
 * `body:<section>`). It is strictly additive — `paths` and `source` are
 * unchanged, so no pair that collided before collides differently now.
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [options]
 * @param {boolean} [options.concreteOnly=false] Skip glob paths on both sides.
 * @param {string} [options.tempRoot]
 * @returns {{ paths: string[], source: string, attribution: Array<{ path: string, declared: boolean, fields: string[] }> }|null}
 */
export function detectCollision(
  a,
  b,
  { concreteOnly = false, ...evidence } = {},
) {
  const fa = storyFootprints(a, evidence);
  if (fa.widened.size === 0) return null;
  const fb = storyFootprints(b, evidence);
  if (fb.widened.size === 0) return null;

  const hits = new Map();
  for (const path of fa.widened) {
    if (!isGlobPath(path) && fb.widened.has(path)) {
      recordHit(hits, path, fa.declared.has(path) && fb.declared.has(path));
    }
  }
  if (!concreteOnly) {
    recordGlobs(hits, fa);
    recordGlobs(hits, fb);
  }
  if (hits.size === 0) return null;
  const paths = [...hits.keys()].sort();
  return {
    paths,
    source: [...hits.values()].some(Boolean)
      ? OVERLAP_SOURCES.DECLARED
      : OVERLAP_SOURCES.SCRAPED,
    attribution: paths.map((path) =>
      attributePath(fa, fb, path, hits.get(path)),
    ),
  };
}

/**
 * Render one collision's scraped-path provenance as a single operator-facing
 * clause, or `''` when every colliding path was declared by both sides.
 *
 * Shared by every report that names a withhold so the tick's envelope note
 * and plan-persist's predicted-serialisation table read identically — the two
 * surfaces describe the same computation and an operator comparing them
 * should not have to translate (Story #5265).
 *
 * @param {Array<{ path: string, declared: boolean, fields: string[] }>} attribution
 * @returns {string}
 */
export function renderScrapeAttribution(attribution) {
  const scraped = (Array.isArray(attribution) ? attribution : []).filter(
    (entry) => Array.isArray(entry?.fields) && entry.fields.length > 0,
  );
  if (scraped.length === 0) return '';
  return scraped
    .map((entry) => `${entry.path} ← ${entry.fields.join(', ')}`)
    .join('; ');
}
