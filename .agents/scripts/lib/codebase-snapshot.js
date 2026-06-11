/**
 * codebase-snapshot.js — Bounded structural view of the consumer repo.
 *
 * Story #2634 (sibling to #2635 spec-freshness). `/plan` Phase 7
 * authors PRD + Tech Spec from documentation alone — `architecture.md`,
 * `data-dictionary.md`, `decisions.md`, `patterns.md`. When those docs
 * drift from the real source tree, the Architect persona cites modules
 * and paths that no longer exist, and the mismatch only surfaces at
 * delivery time.
 *
 * `buildCodebaseSnapshot` produces a deterministic JSON view of the repo
 * that gets threaded into the spec-author's authoring context alongside
 * `docsContext`, so the Architect can prefer real module names over
 * doc-only ones.
 *
 * Two tiers, picked from `planning.codebaseSnapshot.tier`:
 *
 *   - `skinny` (default) — file tree (paths only) of the configured
 *     include globs, `package.json` exports + bin entries, the detected
 *     test runner, the BDD feature root, and the list of directories
 *     touched in the most recent `recentCommitWindow` commits.
 *
 *   - `medium` — skinny + a single-line export signature per public
 *     `.js` / `.ts` / `.mjs` file in the include set. Signatures are
 *     extracted from a regex pass over the file body — deliberately not
 *     a full AST so the snapshot stays cheap to generate on every plan
 *     run. The regex catches the common shapes (`export function foo`,
 *     `export class Bar`, `export const baz`, `export default`).
 *
 * The snapshot never throws on a probe failure. A missing git ref,
 * unreadable directory, or absent BDD root all degrade to an empty /
 * sentinel value in the corresponding field so Phase 7 stays
 * non-blocking.
 */

import fs from 'node:fs';
import path from 'node:path';

import { gitSpawn } from './git-utils.js';
import { Logger } from './Logger.js';

/**
 * Allowed tier values for `planning.codebaseSnapshot.tier`. Mirrored
 * in `agentrc.schema.json` so a typo lands as a schema-validation
 * error before the runner is reached.
 */
export const CODEBASE_SNAPSHOT_TIERS = Object.freeze(['skinny', 'medium']);

const DEFAULT_INCLUDE = Object.freeze([
  '.agents/scripts/**',
  'src/**',
  'lib/**',
  'app/**',
  'packages/**',
]);

const DEFAULT_EXCLUDE = Object.freeze([
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/*.test.*',
  '**/*.spec.*',
]);

const DEFAULT_RECENT_COMMIT_WINDOW = 30;

const SIGNATURE_FILE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

/**
 * Hard cap on the file list in the skinny tier. When the include set
 * matches more than `MAX_FILES_SKINNY` tracked files, the result is
 * truncated and `truncated: true` is set on the envelope so the
 * Architect (and the Phase 7 authoring-context warning) sees that the
 * snapshot is incomplete and can ask for `medium` (or narrow the
 * include globs). 250 entries is roughly 4–6k tokens of paths on
 * typical repos — the upper edge of the Phase 7 budget.
 */
const MAX_FILES_SKINNY = 250;

/**
 * Group a sorted file list by its top-level directory. The top-level
 * segment is the first path component (`.agents/scripts/lib/foo.js` →
 * `.agents`, `src/index.ts` → `src`). Returns an insertion-ordered Map
 * keyed by top-level dir whose values are the files under it, preserving
 * the input order within each group. Because the input is pre-sorted
 * lexicographically and we never reorder, group keys appear in sorted
 * order and per-group file order is sorted too — the whole operation
 * is deterministic for a given tree.
 *
 * @param {string[]} files - Lexicographically sorted relative paths.
 * @returns {Map<string, string[]>}
 */
function groupByTopLevel(files) {
  const groups = new Map();
  for (const file of files) {
    const slash = file.indexOf('/');
    const top = slash === -1 ? file : file.slice(0, slash);
    let bucket = groups.get(top);
    if (!bucket) {
      bucket = [];
      groups.set(top, bucket);
    }
    bucket.push(file);
  }
  return groups;
}

/**
 * Apply the skinny-tier cap with **per-top-level-dir proportional
 * budgeting** so a large, dot-prefixed tree (e.g. `.agents/scripts/**`)
 * can no longer monopolise the budget and truncate away the consumer's
 * own source. The flat `filtered.slice(0, cap)` it replaces kept only
 * the lexicographically-first `cap` paths, and dot-prefixed paths sort
 * ahead of every consumer path — so in any consumer repo whose include
 * set exceeds the cap, the snapshot devolved to mostly `.agents/**`.
 *
 * Algorithm (deterministic, no time/randomness):
 *   1. Group the sorted file list by top-level directory.
 *   2. Round-robin across the groups (in sorted key order), taking one
 *      file from each group per pass, until the cap is filled or every
 *      group is exhausted. Round-robin gives each top-level tree a fair,
 *      proportional share of the budget regardless of its absolute size.
 *   3. Re-sort the selected subset so the emitted `files` array stays in
 *      stable lexicographic order (same shape the rest of the pipeline
 *      and the golden tests expect).
 *
 * When only one top-level group matches (the Mandrel-repo dogfood case,
 * where `.agents/scripts/**` is the only matching tree), round-robin
 * degenerates to "take the first `cap` from that one group" — identical
 * to the old behaviour, so the Mandrel snapshot stays useful.
 *
 * @param {string[]} sortedFiles - Lexicographically sorted relative paths.
 * @param {number} cap - Maximum number of files to keep.
 * @returns {string[]} The kept subset, lexicographically sorted, length ≤ cap.
 */
function proportionalCap(sortedFiles, cap) {
  if (sortedFiles.length <= cap) return sortedFiles;
  const groups = [...groupByTopLevel(sortedFiles).values()];
  const kept = [];
  let exhausted = false;
  for (let pass = 0; !exhausted && kept.length < cap; pass += 1) {
    exhausted = true;
    for (const bucket of groups) {
      if (pass >= bucket.length) continue;
      exhausted = false;
      kept.push(bucket[pass]);
      if (kept.length >= cap) break;
    }
  }
  kept.sort();
  return kept;
}

/**
 * Resolve the snapshot configuration from a raw `.agentrc.json` block.
 * Defaults fill in every absent field so callers can hand the result
 * straight to `buildCodebaseSnapshot` without further normalisation.
 *
 * @param {object} [raw] - `planning.codebaseSnapshot` block (may be undefined).
 * @returns {{ tier: string, include: string[], exclude: string[], recentCommitWindow: number }}
 */
export function resolveSnapshotConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const tier = CODEBASE_SNAPSHOT_TIERS.includes(cfg.tier) ? cfg.tier : 'skinny';
  const include =
    Array.isArray(cfg.include) && cfg.include.length > 0
      ? cfg.include.map(String)
      : [...DEFAULT_INCLUDE];
  const exclude =
    Array.isArray(cfg.exclude) && cfg.exclude.length > 0
      ? cfg.exclude.map(String)
      : [...DEFAULT_EXCLUDE];
  const recentCommitWindow =
    Number.isInteger(cfg.recentCommitWindow) && cfg.recentCommitWindow > 0
      ? cfg.recentCommitWindow
      : DEFAULT_RECENT_COMMIT_WINDOW;
  return { tier, include, exclude, recentCommitWindow };
}

/**
 * Compile one glob entry into a per-segment regex. Supports `**`,
 * `*`, and literal segments. Deliberately small — we don't pull
 * `micromatch` so the snapshot stays self-contained.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function compileGlob(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // `**` becomes `.*` (cross-segment), `*` becomes `[^/]*` (single segment).
  // We replace `**` first via a placeholder so the single-`*` rule doesn't
  // chew on its inner stars.
  const pattern = escaped
    .replace(/\*\*/g, 'DOUBLESTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/DOUBLESTAR/g, '.*');
  return new RegExp(`^${pattern}$`);
}

/**
 * Compile a list of glob entries to RegExp once. Callers hoist this out
 * of the per-file loop so the snapshot pays the (cheap but non-zero)
 * compilation cost a fixed number of times per `buildCodebaseSnapshot`
 * call — ~13 globs total — rather than recompiling every glob for every
 * tracked file (thousands of RegExp constructions on a real repo).
 *
 * @param {string[]} globs
 * @returns {RegExp[]}
 */
function compileGlobs(globs) {
  return globs.map(compileGlob);
}

/**
 * Match `path` against any precompiled glob RegExp. Both the candidate
 * and the globs are normalized to forward slashes (the globs at compile
 * time, the candidate here) so Windows callsites see the same shape as
 * POSIX ones.
 *
 * @param {string} candidate
 * @param {RegExp[]} compiledGlobs
 * @returns {boolean}
 */
function matchesAny(candidate, compiledGlobs) {
  const normalised = candidate.replace(/\\/g, '/');
  for (const re of compiledGlobs) {
    if (re.test(normalised)) return true;
  }
  return false;
}

/**
 * List every tracked file under the repo via `git ls-files`. We avoid
 * a node-level filesystem walk so `.gitignore` is naturally honoured
 * and the snapshot is bounded by what's actually in the repo.
 *
 * Returns an empty array if git fails — non-blocking by design.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function listTrackedFiles(cwd) {
  const result = gitSpawn(cwd, 'ls-files');
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * List directories touched in the most recent `window` commits. Uses
 * `git log -<N> --name-only` and reduces the result to a unique set
 * of top-two-level directories (so `.agents/scripts/lib/foo.js` →
 * `.agents/scripts/lib`). Caps the response at 25 entries so the
 * field stays readable in the spec-author envelope.
 *
 * @param {string} cwd
 * @param {number} window
 * @returns {string[]}
 */
function listRecentlyTouchedDirs(cwd, window) {
  const result = gitSpawn(
    cwd,
    'log',
    `-${window}`,
    '--name-only',
    '--pretty=format:',
  );
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  const dirs = new Set();
  for (const raw of result.stdout.split(/\r?\n/)) {
    const file = raw.trim();
    if (file.length === 0) continue;
    const parts = file.replace(/\\/g, '/').split('/');
    if (parts.length < 2) {
      dirs.add(parts[0]);
      continue;
    }
    // Top-two-level directory keeps the field useful for a planner
    // ("activity recently concentrated in `.agents/scripts/lib/`")
    // without devolving into a per-file list.
    dirs.add(parts.slice(0, Math.min(3, parts.length - 1)).join('/'));
  }
  const out = [...dirs];
  out.sort();
  return out.slice(0, 25);
}

/**
 * Read `package.json` and pull the entries Phase 7 actually needs:
 * declared `exports`, `bin` keys, the `main` entry, and `scripts`
 * names. Returns `{}` when the file is missing or unparsable.
 *
 * @param {string} cwd
 * @returns {object}
 */
function readPackageManifestSurface(cwd, logger) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    logger.debug(
      `[codebase-snapshot] package.json read/parse failed for ${pkgPath}: ${err?.message ?? err}`,
    );
    return {};
  }
  const exportsField = parsed.exports;
  const exportPaths =
    typeof exportsField === 'string'
      ? [exportsField]
      : exportsField && typeof exportsField === 'object'
        ? Object.keys(exportsField)
        : [];
  const binField = parsed.bin;
  const binNames =
    typeof binField === 'string'
      ? [path.basename(binField)]
      : binField && typeof binField === 'object'
        ? Object.keys(binField)
        : [];
  return {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    main: typeof parsed.main === 'string' ? parsed.main : null,
    exports: exportPaths,
    bin: binNames,
    scripts:
      parsed.scripts && typeof parsed.scripts === 'object'
        ? Object.keys(parsed.scripts)
        : [],
  };
}

const EXPORT_SIGNATURE_RE =
  /^\s*export\s+(?:default\s+(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/gm;

/**
 * Extract a sorted, deduped list of exported identifiers from one file.
 * Deliberately regex-based (not an AST parse) so the snapshot is cheap.
 *
 * @param {string} body
 * @returns {string[]}
 */
function extractExportSignatures(body) {
  const names = new Set();
  EXPORT_SIGNATURE_RE.lastIndex = 0;
  let match = EXPORT_SIGNATURE_RE.exec(body);
  while (match !== null) {
    for (let i = 1; i < match.length; i += 1) {
      if (match[i]) names.add(match[i]);
    }
    match = EXPORT_SIGNATURE_RE.exec(body);
  }
  // Also catch `export { a, b }` patterns separately — the omnibus
  // regex above is busy enough without trying to absorb braces.
  const braceRe = /export\s*\{\s*([^}]+)\s*\}/g;
  let braceMatch = braceRe.exec(body);
  while (braceMatch !== null) {
    for (const piece of braceMatch[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
    braceMatch = braceRe.exec(body);
  }
  return [...names].sort();
}

/**
 * Build the medium-tier signature map. Walks every tracked file that
 * matches the include/exclude globs and pulls export names from each
 * `.js` / `.ts` body. Skips files larger than 64 KiB so an accidentally
 * checked-in bundle can't blow the snapshot budget.
 *
 * @param {string} cwd
 * @param {string[]} tracked
 * @returns {Array<{ path: string, exports: string[] }>}
 */
function collectSignatures(cwd, tracked, logger) {
  const out = [];
  for (const rel of tracked) {
    const ext = path.extname(rel).toLowerCase();
    if (!SIGNATURE_FILE_EXTS.has(ext)) continue;
    const abs = path.join(cwd, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      logger.debug(
        `[codebase-snapshot] stat failed for ${abs}: ${err?.message ?? err}`,
      );
      continue;
    }
    if (stat.size > 64 * 1024) continue;
    let body;
    try {
      body = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      logger.debug(
        `[codebase-snapshot] readFile failed for ${abs}: ${err?.message ?? err}`,
      );
      continue;
    }
    const exports = extractExportSignatures(body);
    if (exports.length === 0) continue;
    out.push({ path: rel.replace(/\\/g, '/'), exports });
  }
  return out;
}

/**
 * Detect the project's test framework + BDD feature root by reading
 * `package.json` scripts and probing well-known directories. Returns
 * a `{ runner, featureRoots }` envelope that the Architect can cite
 * directly when authoring acceptance criteria.
 *
 * @param {string} cwd
 * @param {{ scripts: string[] }} pkg
 * @returns {{ runner: string|null, featureRoots: string[] }}
 */
function detectTestSurface(cwd, pkg) {
  let runner = null;
  if (Array.isArray(pkg.scripts)) {
    if (pkg.scripts.includes('test')) runner = 'npm test';
  }
  // Probe canonical BDD feature locations. The actual scanner that
  // Story #2637 will land does a more thorough scan; the snapshot
  // just records the root so the Architect can cite it.
  const featureRoots = [];
  for (const candidate of ['tests/features', 'features']) {
    if (fs.existsSync(path.join(cwd, candidate))) featureRoots.push(candidate);
  }
  return { runner, featureRoots };
}

/**
 * Build the codebase snapshot. Pure with respect to the args (no
 * environment reads beyond the explicit `cwd`); never throws.
 *
 * @param {object} opts
 * @param {string} [opts.cwd] - Repo root (defaults to process.cwd()).
 * @param {string} [opts.tier] - `skinny` | `medium`.
 * @param {string[]} [opts.include] - Glob allowlist.
 * @param {string[]} [opts.exclude] - Glob blocklist (applied after include).
 * @param {number} [opts.recentCommitWindow] - How many recent commits to scan.
 * @returns {{
 *   tier: string,
 *   generatedAt: string,
 *   pkg: object,
 *   files: string[],
 *   recentlyTouched: string[],
 *   testSurface: { runner: string|null, featureRoots: string[] },
 *   signatures: Array<{ path: string, exports: string[] }> | null,
 * }}
 */
export function buildCodebaseSnapshot(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? Logger;
  const cfg = resolveSnapshotConfig({
    tier: opts.tier,
    include: opts.include,
    exclude: opts.exclude,
    recentCommitWindow: opts.recentCommitWindow,
  });

  const tracked = listTrackedFiles(cwd);
  // Compile the include/exclude globs to RegExp exactly once per call
  // (memoized here, hoisted out of the per-file loop) so a repo with
  // thousands of tracked files doesn't trigger thousands of RegExp
  // constructions. See `compileGlobs`.
  const includeRes = compileGlobs(cfg.include);
  const excludeRes = compileGlobs(cfg.exclude);
  const filtered = tracked.filter(
    (f) => matchesAny(f, includeRes) && !matchesAny(f, excludeRes),
  );
  filtered.sort();

  const pkg = readPackageManifestSurface(cwd, logger);
  const recentlyTouched = listRecentlyTouchedDirs(cwd, cfg.recentCommitWindow);
  const testSurface = detectTestSurface(cwd, pkg);

  let displayFiles = filtered;
  let truncated = false;
  if (cfg.tier === 'skinny' && filtered.length > MAX_FILES_SKINNY) {
    // Proportional per-top-level-dir budgeting (not a flat lexicographic
    // slice) so consumer source survives the cap even when a dot-prefixed
    // tree like `.agents/scripts/**` sorts ahead of it. See `proportionalCap`.
    displayFiles = proportionalCap(filtered, MAX_FILES_SKINNY);
    truncated = true;
  }

  const snapshot = {
    tier: cfg.tier,
    generatedAt: new Date().toISOString(),
    pkg,
    files: displayFiles,
    fileCount: filtered.length,
    truncated,
    recentlyTouched,
    testSurface,
    signatures: null,
  };

  if (cfg.tier === 'medium') {
    snapshot.signatures = collectSignatures(cwd, filtered, logger);
  }

  return snapshot;
}
