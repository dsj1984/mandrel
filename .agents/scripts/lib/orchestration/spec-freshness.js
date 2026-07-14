/**
 * spec-freshness.js — path-reference helpers for plan authoring.
 *
 * Stage 5 retired the epic-era `validateSpecFreshness` / structured-comment
 * reporter (no production callers remained after the planning collapse).
 * Survivors: path-cue extraction used by `planning/authoring-context.js`
 * and the plan-authoring grounding tests.
 */

/**
 * Path-shape regexes. Three forms the Architect persona emits today:
 *
 *   1. Backticked reference   →  `` `src/auth.ts` ``
 *   2. Code-block file header →  `// src/auth.ts` or `# lib/foo.py`
 *   3. Inline prose mention   →  bare `src/auth.ts` between word boundaries
 *
 * All three pull the same captured-path group. We anchor the path on a
 * known repo root (`.agents`, `src`, `lib`, `app`, `tests`, `packages`,
 * `scripts`, `docs`) so we don't false-positive on `library`, `testimonial`,
 * versioned semver fragments, etc.
 */
const PATH_ROOTS = [
  '\\.agents',
  'src',
  'lib',
  'app',
  'tests',
  'packages',
  'scripts',
  'docs',
];

const PATH_BODY = '[\\w./-]+\\.[a-zA-Z0-9]{1,8}';

const BACKTICK_PATH_RE = new RegExp(
  `\`((?:${PATH_ROOTS.join('|')})/${PATH_BODY})\``,
  'g',
);

const COMMENT_HEADER_PATH_RE = new RegExp(
  `(?:^|\\n)\\s*(?://|#)\\s*((?:${PATH_ROOTS.join('|')})/${PATH_BODY})\\b`,
  'g',
);

const BARE_PATH_RE = new RegExp(
  `(?:^|[\\s([<>])((?:${PATH_ROOTS.join('|')})/${PATH_BODY})(?=[\\s)\\].,;:]|$)`,
  'g',
);

/**
 * Words in surrounding prose that signal a reference is intentionally
 * net-new — the planner is *proposing* the path, not asserting it exists.
 * When any of these appear within `AMBIGUITY_WINDOW` characters of the
 * match, we treat the citation as intentional rather than drift.
 */
const NEW_FILE_CUES = [
  'introduce',
  'introduces',
  'introducing',
  'add',
  'adds',
  'adding',
  'create',
  'creates',
  'creating',
  'new file',
  'new module',
  'new helper',
  'to be created',
  'will be created',
  'net-new',
  'scaffold',
  'scaffolds',
  'scaffolding',
];

const AMBIGUITY_WINDOW = 80;

/**
 * Check whether the prose surrounding `index` carries one of the
 * net-new cue phrases. Looks both before and after the match within
 * `AMBIGUITY_WINDOW` characters because authors phrase the cue either
 * way: "introduce src/x.ts" *or* "src/x.ts (new helper)".
 *
 * Case-insensitive substring match — deliberately not regex/word-boundary
 * so future cue variants don't silently slip the gate.
 *
 * @param {string} body
 * @param {number} index
 * @param {number} matchLength
 * @returns {boolean}
 */
export function hasNewFileCue(body, index, matchLength) {
  const start = Math.max(0, index - AMBIGUITY_WINDOW);
  const end = Math.min(body.length, index + matchLength + AMBIGUITY_WINDOW);
  const window = body.slice(start, end).toLowerCase();
  for (const cue of NEW_FILE_CUES) {
    if (window.includes(cue)) return true;
  }
  return false;
}

/**
 * Collect every `(path, index, matchLength)` triple from `body` using the
 * three path-shape regexes. The same path can surface at multiple indices —
 * each callsite is preserved so the ambiguity check runs against the cue at
 * *that* index, not a different one.
 *
 * @param {string} body
 * @returns {Array<{ path: string, index: number, matchLength: number }>}
 */
export function collectReferences(body) {
  const refs = [];
  for (const re of [BACKTICK_PATH_RE, COMMENT_HEADER_PATH_RE, BARE_PATH_RE]) {
    re.lastIndex = 0;
    let match = re.exec(body);
    while (match !== null) {
      const captured = match[1];
      const captureIndex = match.index + match[0].indexOf(captured);
      refs.push({
        path: captured,
        index: captureIndex,
        matchLength: captured.length,
      });
      match = re.exec(body);
    }
  }
  return refs;
}
