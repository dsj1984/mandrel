/**
 * spec-freshness.js — Tech Spec post-author cross-validation against the
 * current codebase.
 *
 * `/plan` Phase 7 authors PRD + Tech Spec from documentation alone.
 * When `project.docsContextFiles` (architecture.md, etc.) drift from
 * the real source tree, the Architect persona happily cites modules and
 * paths that no longer exist. The mismatch only surfaces at delivery time,
 * after Phase 8 has already decomposed the stale spec into Tasks.
 *
 * `validateSpecFreshness` scans a Tech Spec body for path-shaped references,
 * probes each against `baseBranchRef` (via `git cat-file -e`), and returns a
 * `{ stale, fresh, ambiguous }` envelope. The caller (epic-plan-spec.js)
 * uses the result to write a JSON report and post an advisory structured
 * comment on the Tech Spec issue. The check is intentionally non-blocking —
 * planning continues even when stale references are present, because the
 * operator may legitimately be planning to create the path the Tech Spec
 * cites.
 *
 * Sibling to {@link ./ticket-validator.js#validateAcFreshness}, which runs at
 * Phase 8 (decompose) time against Task bodies. This module operates one
 * phase earlier, on the spec body that feeds the decomposer.
 */

import { gitSpawn } from '../git-utils.js';

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
 * match, we mark the reference `ambiguous` rather than `stale`.
 *
 * Conservative on purpose: false-positives here downgrade real staleness
 * to ambiguity, but the operator-visible comment still lists the path so
 * nothing is hidden — just demoted in the report's headline count.
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
 * Default git probe: returns true when `path` exists at `baseBranchRef`.
 * Mirrors the probe in ticket-validator.js so the two freshness gates
 * share semantics. Callers may inject a `(opts) => boolean` runner with
 * the same shape for unit tests.
 *
 * @param {{ baseBranchRef: string, path: string, cwd?: string }} opts
 * @returns {boolean}
 */
function defaultGitRunner({ baseBranchRef, path, cwd }) {
  const result = gitSpawn(
    cwd ?? process.cwd(),
    'cat-file',
    '-e',
    `${baseBranchRef}:${path}`,
  );
  return result.status === 0;
}

/**
 * Find the 1-based line number for a string index into `body`.
 *
 * @param {string} body
 * @param {number} index
 * @returns {number}
 */
function lineNumberFor(body, index) {
  let line = 1;
  for (let i = 0; i < index && i < body.length; i += 1) {
    if (body.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Check whether the prose surrounding `index` carries one of the
 * net-new cue phrases. Looks both before and after the match within
 * `AMBIGUITY_WINDOW` characters because authors phrase the cue either
 * way: "introduce src/x.ts" *or* "src/x.ts (new helper)".
 *
 * Case-insensitive substring match — deliberately not regex/word-boundary
 * so future cue variants don't silently slip the gate. False positives
 * downgrade staleness to ambiguity, which is the safe direction.
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
 * each callsite is preserved so the report can cite every line and the
 * ambiguity check runs against the cue at *that* index, not a different one.
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

/**
 * Validate every code-asset path the Tech Spec body references against
 * `baseBranchRef`. Returns a `{ stale, fresh, ambiguous }` envelope.
 *
 * Each result element has the shape `{ path, line }` — `line` is the
 * 1-based line number of the *first* citation of `path` in `body`. When
 * the same path appears multiple times, the result is deduped by path
 * but `citations` carries every `{ line }` for downstream rendering.
 *
 * Buckets:
 *   - `stale`     — path is absent from `baseBranchRef` and prose has no
 *                   new-file cue nearby. Real likely-hallucinated reference.
 *   - `fresh`     — path exists at `baseBranchRef`. No action needed.
 *   - `ambiguous` — path is absent from `baseBranchRef` but surrounding
 *                   prose carries a new-file cue. Probably intentional;
 *                   surfaced for operator review without alarming the
 *                   headline count.
 *
 * The function never throws on a missing git ref — the runner is
 * expected to return `false` for any unreadable probe and the path lands
 * in `stale` (or `ambiguous`). Non-blocking by design.
 *
 * @param {string} specBody
 * @param {{ baseBranchRef: string, gitRunner?: Function, cwd?: string }} opts
 * @returns {{ stale: Array, fresh: Array, ambiguous: Array }}
 */
export function validateSpecFreshness(specBody, opts = {}) {
  if (typeof specBody !== 'string') {
    throw new TypeError('validateSpecFreshness: specBody must be a string.');
  }
  const { baseBranchRef, gitRunner = defaultGitRunner, cwd } = opts;
  if (!baseBranchRef || typeof baseBranchRef !== 'string') {
    throw new Error(
      'validateSpecFreshness: baseBranchRef is required and must be a string.',
    );
  }

  const refs = collectReferences(specBody);
  const probeCache = new Map();
  const buckets = { stale: [], fresh: [], ambiguous: [] };
  const seen = new Map(); // path → bucket entry

  for (const { path, index, matchLength } of refs) {
    const line = lineNumberFor(specBody, index);
    let exists = probeCache.get(path);
    if (exists === undefined) {
      exists = gitRunner({ baseBranchRef, path, cwd });
      probeCache.set(path, exists);
    }
    let bucket;
    if (exists) {
      bucket = 'fresh';
    } else if (hasNewFileCue(specBody, index, matchLength)) {
      bucket = 'ambiguous';
    } else {
      bucket = 'stale';
    }
    const existing = seen.get(path);
    if (existing) {
      // Same path cited multiple times. Append the citation and, if any
      // citation lacks a new-file cue, downgrade to stale — the most
      // serious bucket wins so the operator sees the strongest signal.
      existing.citations.push({ line });
      if (existing.bucket === 'ambiguous' && bucket === 'stale') {
        // Move entry from ambiguous → stale.
        const idx = buckets.ambiguous.indexOf(existing);
        if (idx >= 0) buckets.ambiguous.splice(idx, 1);
        existing.bucket = 'stale';
        buckets.stale.push(existing);
      }
      continue;
    }
    const entry = { path, line, citations: [{ line }], bucket };
    seen.set(path, entry);
    buckets[bucket].push(entry);
  }

  // Strip the internal `bucket` field from the returned envelope — it's a
  // scratch marker only the dedupe pass cares about.
  const strip = (arr) =>
    arr.map(({ path, line, citations }) => ({ path, line, citations }));
  return {
    stale: strip(buckets.stale),
    fresh: strip(buckets.fresh),
    ambiguous: strip(buckets.ambiguous),
  };
}

/**
 * Render the Markdown body for the `spec-freshness` structured comment.
 * Kept in this module so the comment shape and the validator stay in
 * lock-step — a reviewer reading the report knows where to find the
 * exact rendering contract.
 *
 * @param {{ stale: Array, ambiguous: Array, fresh: Array }} report
 * @param {{ baseBranchRef: string, techSpecId?: number, epicId?: number }} ctx
 * @returns {string}
 */
export function renderSpecFreshnessComment(report, ctx) {
  const { baseBranchRef, epicId } = ctx;
  const staleCount = report.stale.length;
  const ambiguousCount = report.ambiguous.length;
  const freshCount = report.fresh.length;
  const header = epicId
    ? `## Tech Spec freshness check (Epic #${epicId})`
    : '## Tech Spec freshness check';
  const summary = `${staleCount} stale · ${ambiguousCount} ambiguous · ${freshCount} fresh against \`${baseBranchRef}\`.`;
  const sections = [header, '', summary, ''];
  if (staleCount > 0) {
    sections.push('### Stale references');
    sections.push('');
    sections.push(
      'These paths do not exist at the base branch and the surrounding prose does not signal them as net-new. Either correct the citation or rephrase the spec to mark the path as net-new.',
    );
    sections.push('');
    for (const entry of report.stale) {
      const lines = entry.citations.map((c) => `L${c.line}`).join(', ');
      sections.push(`- \`${entry.path}\` (${lines})`);
    }
    sections.push('');
  }
  if (ambiguousCount > 0) {
    sections.push('### Ambiguous references');
    sections.push('');
    sections.push(
      'These paths do not exist at the base branch but the surrounding prose suggests they are net-new. Confirm or correct.',
    );
    sections.push('');
    for (const entry of report.ambiguous) {
      const lines = entry.citations.map((c) => `L${c.line}`).join(', ');
      sections.push(`- \`${entry.path}\` (${lines})`);
    }
    sections.push('');
  }
  sections.push(
    '_This is an advisory check; planning continues regardless. Sourced from `spec-freshness.js` after Phase 7 spec authoring._',
  );
  return sections.join('\n');
}
