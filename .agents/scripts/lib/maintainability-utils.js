import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import { POOL_SERIAL_THRESHOLD, runOnPool } from './cpu-pool.js';
import { Logger } from './Logger.js';
import { calculateForFile } from './maintainability-engine.js';

const MAINTAINABILITY_WORKER_URL = new URL(
  './workers/maintainability-worker.js',
  import.meta.url,
);

// Pool-vs-serial cutover — single-sourced in cpu-pool.js (see the
// POOL_SERIAL_THRESHOLD docstring for the tuning rationale).
const SERIAL_THRESHOLD = POOL_SERIAL_THRESHOLD;

const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SUPPORTED_EXTS = new Set([...JS_EXTS, ...TS_EXTS]);

/**
 * @returns {boolean} True when the path's extension is one the engines score.
 */
function isSupportedSourceFile(filePath) {
  return SUPPORTED_EXTS.has(path.extname(String(filePath)).toLowerCase());
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'temp',
  '.worktrees',
  'coverage',
  '.next',
]);

/**
 * Test whether an absolute (or repo-relative) file path matches any of the
 * configured `ignoreGlobs`. This is the single source of truth for how the
 * maintainability scorer decides a file is ignored: both the full-scope
 * directory walk (`scanDirectory` below) and the diff-scope file-list path
 * in `refresh-service.js` MUST funnel through it so an `ignoreGlobs`-listed
 * file is excluded identically in both scopes (a diff-scope refresh that
 * skipped this check would let an ignored file poison the `rollup["*"].min`
 * floor — see `buildDefaultMaintainabilityScorer`).
 *
 * Matching mirrors `scanDirectory`: the path is reduced to a canonicalised,
 * POSIX, repo-relative form and tested against each glob with minimatch's
 * `{ dot: true }` so dot-prefixed roots like `.agents/` match.
 *
 * @param {string} filePath absolute or relative path to the source file
 * @param {string[]} ignoreGlobs minimatch patterns; empty/absent is a no-op
 * @param {string} [cwd] root for repo-relative resolution; defaults to cwd
 * @returns {boolean} true when the file matches at least one ignore glob
 */
export function isIgnoredByGlobs(filePath, ignoreGlobs = [], cwd) {
  if (!Array.isArray(ignoreGlobs) || ignoreGlobs.length === 0) return false;
  const matchCwd = cwd ?? process.cwd();
  const absFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(matchCwd, filePath);
  const rawRel = path.relative(matchCwd, absFilePath).replace(/\\/g, '/');
  const relPath = canonicalisePath(rawRel);
  return ignoreGlobs.some((g) => minimatch(relPath, g, { dot: true }));
}

/**
 * Recursively scans a directory for JS/TS source files. Accepts `.js`,
 * `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts`. Directories listed
 * in `IGNORED_DIRS` (including `coverage` and `.next`, added in 5.29.0
 * to skip vitest's istanbul HTML scaffolding and Next.js build output)
 * are skipped.
 *
 * @param {string} dir
 * @param {string[]} fileList
 * @param {{ ignoreGlobs?: string[], cwd?: string }} [opts]
 *   `ignoreGlobs` — minimatch patterns matched against the canonicalised
 *   repo-relative path of each discovered file. Files whose path matches
 *   any pattern are excluded before scoring. Absent/empty is a no-op.
 *   `cwd` — root used to compute repo-relative paths for glob matching;
 *   defaults to `process.cwd()` when omitted.
 * @returns {string[]}
 */
export function scanDirectory(dir, fileList = [], opts = {}) {
  const { ignoreGlobs = [], cwd: optsCwd } = opts;
  const matchCwd = optsCwd ?? process.cwd();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return fileList;
    throw err;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        scanDirectory(filePath, fileList, opts);
      }
    } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
      if (isIgnoredByGlobs(filePath, ignoreGlobs, matchCwd)) {
        continue;
      }
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Calculates maintainability scores for a list of file paths.
 *
 * Each file's transpile-then-analyze unit is dispatched to a
 * worker_threads pool sized to `os.availableParallelism()`. Workers
 * are recycled across files so TypeScript loads at most once per
 * worker. The pool is bypassed for batches of fewer than
 * `SERIAL_THRESHOLD` files because spawn overhead dominates at small
 * sizes — the in-process path matches the pre-pool serial behaviour
 * byte-for-byte.
 *
 * Output is sorted by relative file path so the returned object is
 * insertion-order-stable regardless of which worker happened to
 * finish first. Files that fail to read/transpile/parse are dropped
 * from the result (matching the pre-pool log-and-continue contract);
 * worker-side per-item failures surface as a `null` score that is
 * filtered out before assembly.
 *
 * @param {string[]} paths
 * @returns {Promise<Record<string, number>>}
 */
export async function calculateAll(paths) {
  const cwd = process.cwd();
  const indexed = paths.map((p) => ({
    abs: p,
    relPath: path.relative(cwd, p).replace(/\\/g, '/'),
  }));

  let perFile;
  if (indexed.length < SERIAL_THRESHOLD) {
    perFile = indexed.map(({ abs, relPath }) => {
      try {
        return { relPath, score: calculateForFile(abs) };
      } catch (err) {
        Logger.error(
          `[Maintainability] Failed to process ${abs}: ${err.message}`,
        );
        return { relPath, score: null };
      }
    });
  } else {
    const results = await runOnPool(
      MAINTAINABILITY_WORKER_URL,
      indexed.map((e) => e.abs),
    );
    perFile = results.map((r, i) => {
      const { abs, relPath } = indexed[i];
      if (!r || r.__cpuPoolError) {
        Logger.error(
          `[Maintainability] Worker pool error for ${abs}: ${r?.message ?? 'unknown'}`,
        );
        return { relPath, score: null };
      }
      if (r.score === null && r.error) {
        Logger.error(`[Maintainability] Failed to process ${abs}: ${r.error}`);
      }
      return { relPath, score: r.score };
    });
  }

  perFile.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );

  const scores = {};
  for (const { relPath, score } of perFile) {
    if (score === null) continue;
    scores[relPath] = score;
  }
  return scores;
}
