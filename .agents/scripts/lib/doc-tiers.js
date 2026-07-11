/**
 * Doc-tier resolver (Story #4438, Epic #4430 — Context Economy).
 *
 * Pure functions that classify the repository's documentation into the four
 * read-tiers Mandrel's context model recognizes, each entry carrying its
 * on-disk byte size so a byte budget can ratchet against it:
 *
 *   - `alwaysLoaded`  — `CLAUDE.md` plus the transitive closure of its
 *                       `@`-import references (`@AGENTS.md`,
 *                       `@.agents/instructions.md`, the persona, the always-on
 *                       rules, …). This is the context every session re-pays
 *                       on every subagent spawn (instructions.md § 4), so it is
 *                       the primary budget the context-budget ratchet gates.
 *   - `mandatoryRead` — the resolved `project.docsContextFiles` set (prefixed
 *                       by `project.paths.docsRoot`), existing files only. This
 *                       is the `docsContextFiles` half the Epic AC gates; it
 *                       skips silently when the set is unconfigured or its
 *                       files are absent.
 *   - `digestVisible` — the situational **Conditional Reads** docs from
 *                       instructions.md § 3 (`docs/style-guide.md`,
 *                       `docs/web-routes.md`) — surfaced only when a task
 *                       touches UI/routing, i.e. visible through the docs
 *                       digest rather than always read. Existing files only.
 *   - `onDemand`      — the on-demand `.agents/rules/*.md` set (instructions.md
 *                       § 1.F): every rule file that is **not** part of the
 *                       always-on core already captured in `alwaysLoaded`.
 *
 * A file that could appear in more than one tier is kept in its **highest**
 * tier only (alwaysLoaded > mandatoryRead > digestVisible > onDemand), so the
 * four arrays partition the doc set with no double-counting.
 *
 * The closure is discovered by parsing `@`-import references and following
 * them recursively (cycle-safe via a visited set). A candidate `@`-token only
 * counts as an import when it resolves to an existing repo file, which
 * naturally filters prose mentions (`@[USERNAME]`, `noreply@example.com`,
 * backtick-wrapped `` `@`-imported `` phrasing).
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): every function
 * emits only repo-relative paths and byte counts — never file contents.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/**
 * Basename of the always-loaded entry document (the root of the closure).
 * @type {string}
 */
const ENTRY_DOC = 'CLAUDE.md';

/**
 * Always-on core rule files (instructions.md § 1.F). These live in the
 * `alwaysLoaded` closure (imported by `CLAUDE.md`); every other
 * `.agents/rules/*.md` file is `onDemand`.
 * @type {string[]}
 */
const ALWAYS_ON_RULES = ['security-baseline.md', 'git-conventions.md'];

/**
 * Conditional-read docs (instructions.md § 3 — "Conditional Reads"), resolved
 * against `project.paths.docsRoot`. Present in the `digestVisible` tier when
 * they exist.
 * @type {string[]}
 */
const CONDITIONAL_DOCS = ['style-guide.md', 'web-routes.md'];

/**
 * Match `@`-import tokens: an `@` at start-of-line or after whitespace,
 * followed by a path token that stops at whitespace or common closing
 * punctuation. The resolved-file existence check downstream is the real
 * filter; this regex only harvests candidates.
 */
const IMPORT_RE = /(?:^|\s)@([^\s'"`)\]}>,]+)/gm;

/**
 * Default fs surface — a small subset of `node:fs` so callers can inject a
 * fixture double in tests without touching the real filesystem.
 * @typedef {{
 *   existsSync: (p: string) => boolean,
 *   readFileSync: (p: string, enc: string) => string,
 *   statSync: (p: string) => { size: number },
 * }} FsLike
 */

/**
 * Parse the raw `@`-import specifiers from a source document. A trailing `.`
 * or `:` (sentence punctuation) is trimmed so `@AGENTS.md.` still resolves.
 *
 * @param {string} source
 * @returns {string[]} raw specifiers in first-seen order
 */
export function parseImportSpecifiers(source) {
  const specs = [];
  for (const m of String(source ?? '').matchAll(IMPORT_RE)) {
    let spec = m[1];
    // Strip trailing sentence punctuation that the greedy class allowed in.
    while (spec.length > 0 && (spec.endsWith('.') || spec.endsWith(':'))) {
      spec = spec.slice(0, -1);
    }
    if (spec.length > 0) specs.push(spec);
  }
  return specs;
}

/**
 * Convert an absolute path to a repo-relative, posix-separated id.
 *
 * @param {string} root absolute repo root
 * @param {string} abs absolute path
 * @returns {string}
 */
function toRepoRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Build a `{ path, bytes }` entry for a repo file, or `null` when it does not
 * exist. `path` is repo-relative posix; `bytes` is the on-disk byte size.
 *
 * @param {string} root absolute repo root
 * @param {string} rel repo-relative path
 * @param {FsLike} fs
 * @returns {{ path: string, bytes: number } | null}
 */
function fileEntry(root, rel, fs) {
  const abs = path.resolve(root, rel);
  if (!fs.existsSync(abs)) return null;
  let bytes = 0;
  try {
    bytes = fs.statSync(abs).size;
  } catch {
    return null;
  }
  return { path: toRepoRel(root, abs), bytes };
}

/**
 * Resolve the always-loaded closure: `CLAUDE.md` plus every file reachable by
 * recursively parsing `@`-import references. Cycle-safe (a visited set keyed
 * by repo-relative path). Nested imports resolve relative to the importing
 * file's directory (Claude Code `@`-import semantics). Non-resolving `@`-tokens
 * are ignored, so prose mentions never pollute the closure.
 *
 * @param {string} root absolute repo root (where `CLAUDE.md` lives)
 * @param {{ fs?: FsLike }} [opts]
 * @returns {Array<{ path: string, bytes: number }>} sorted by path; empty when
 *   `CLAUDE.md` is absent
 */
export function resolveAlwaysLoadedClosure(root, { fs = nodeFs } = {}) {
  const entryAbs = path.resolve(root, ENTRY_DOC);
  if (!fs.existsSync(entryAbs)) return [];

  const visited = new Set();
  const entries = new Map();
  const queue = [entryAbs];

  while (queue.length > 0) {
    const abs = queue.shift();
    const rel = toRepoRel(root, abs);
    if (visited.has(rel)) continue;
    visited.add(rel);

    if (!fs.existsSync(abs)) continue;
    let bytes = 0;
    let source = '';
    try {
      bytes = fs.statSync(abs).size;
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    entries.set(rel, { path: rel, bytes });

    const dir = path.dirname(abs);
    for (const spec of parseImportSpecifiers(source)) {
      const targetAbs = path.resolve(dir, spec);
      const targetRel = toRepoRel(root, targetAbs);
      if (!visited.has(targetRel) && fs.existsSync(targetAbs)) {
        queue.push(targetAbs);
      }
    }
  }

  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read the resolved `project.docsContextFiles` list from a config object,
 * prefixed by `project.paths.docsRoot`. Mirrors the `contextDocs` half of
 * `resolveDocList` in `validate-docs-freshness.js` (new-shape first, legacy
 * top-level fallback).
 *
 * @param {object} config resolved config (`resolveConfig()` output)
 * @returns {string[]} repo-relative posix doc paths (existence not yet checked)
 */
export function docsContextPaths(config) {
  const project = config?.project ?? config;
  const contextDocs = Array.isArray(project?.docsContextFiles)
    ? project.docsContextFiles
    : Array.isArray(config?.docsContextFiles)
      ? config.docsContextFiles
      : [];
  const docsRoot =
    project?.paths?.docsRoot ?? config?.paths?.docsRoot ?? 'docs';
  return contextDocs.map((f) => path.posix.join(docsRoot, f));
}

/**
 * Resolve the four documentation read-tiers, each entry `{ path, bytes }`,
 * partitioned so no path appears in more than one tier (highest tier wins).
 *
 * @param {object} config resolved config (`resolveConfig()` output)
 * @param {{ root?: string, fs?: FsLike }} [opts]
 * @returns {{ tiers: {
 *   alwaysLoaded: Array<{ path: string, bytes: number }>,
 *   mandatoryRead: Array<{ path: string, bytes: number }>,
 *   digestVisible: Array<{ path: string, bytes: number }>,
 *   onDemand: Array<{ path: string, bytes: number }>,
 * } }}
 */
export function resolveDocTiers(
  config,
  { root = process.cwd(), fs = nodeFs } = {},
) {
  const claimed = new Set();
  const collect = (relPaths) => {
    const out = [];
    for (const rel of relPaths) {
      const entry = fileEntry(root, rel, fs);
      if (!entry) continue;
      if (claimed.has(entry.path)) continue;
      claimed.add(entry.path);
      out.push(entry);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };

  // 1. always-loaded: CLAUDE.md @-import closure. Pre-claim its paths first so
  //    a lower tier never re-lists a closure member.
  const alwaysLoaded = resolveAlwaysLoadedClosure(root, { fs });
  for (const e of alwaysLoaded) claimed.add(e.path);

  // 2. mandatory-read: resolved docsContextFiles (existing files only).
  const docsRoot =
    config?.project?.paths?.docsRoot ?? config?.paths?.docsRoot ?? 'docs';
  const mandatoryRead = collect(docsContextPaths(config));

  // 3. digest-visible: situational Conditional-Read docs.
  const digestVisible = collect(
    CONDITIONAL_DOCS.map((f) => path.posix.join(docsRoot, f)),
  );

  // 4. on-demand: every .agents/rules/*.md that is not an always-on core rule
  //    (the always-on ones already live in the alwaysLoaded closure).
  const onDemand = collect(listOnDemandRules(root, fs));

  return { tiers: { alwaysLoaded, mandatoryRead, digestVisible, onDemand } };
}

/**
 * List the on-demand rule files (repo-relative posix): every `.agents/rules/
 * *.md` whose basename is not an always-on core rule. Returns [] when the
 * rules directory is absent.
 *
 * @param {string} root absolute repo root
 * @param {FsLike} fs
 * @returns {string[]}
 */
function listOnDemandRules(root, fs) {
  const rulesDir = path.resolve(root, '.agents', 'rules');
  let names;
  try {
    names = fs.readdirSync(rulesDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && !ALWAYS_ON_RULES.includes(n))
    .map((n) => path.posix.join('.agents', 'rules', n))
    .sort();
}

/**
 * Sum the `bytes` of every entry in a tier array.
 *
 * @param {Array<{ bytes: number }>} entries
 * @returns {number}
 */
export function tierTotalBytes(entries) {
  return (entries ?? []).reduce((sum, e) => sum + (e?.bytes ?? 0), 0);
}
