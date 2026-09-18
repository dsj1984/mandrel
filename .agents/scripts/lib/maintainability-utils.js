import fs from 'node:fs';
import path from 'node:path';
import { Minimatch } from 'minimatch';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import { POOL_SERIAL_THRESHOLD, runOnPool } from './cpu-pool.js';
import { Logger } from './Logger.js';
import { scoreFile } from './maintainability-engine.js';
import { isScored, reportUnscorable } from './maintainability-unscorable.js';
import { isScorableSourceFile } from './source-extensions.js';

const MAINTAINABILITY_WORKER_URL = new URL(
  './workers/maintainability-worker.js',
  import.meta.url,
);

const SERIAL_THRESHOLD = POOL_SERIAL_THRESHOLD;

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
 * Compiled matchers plus a per-path verdict memo, keyed on the pattern list:
 * functional `minimatch()` recompiles per call, and the gates ask about the
 * same path once per CRAP row. Inputs are immutable config, so it is bounded.
 * `\u0000` is the join separator because it cannot occur in a glob, so two
 * different lists cannot collide onto one key.
 *
 * @type {Map<string, {matchers: import('minimatch').Minimatch[], verdicts: Map<string, boolean>}>}
 */
const IGNORE_MATCHER_CACHE = new Map();

/**
 * Non-string patterns are dropped rather than compiled.
 *
 * @param {string[]} ignoreGlobs
 * @returns {{matchers: import('minimatch').Minimatch[], verdicts: Map<string, boolean>}}
 */
function ignoreMatcherEntry(ignoreGlobs) {
  const key = ignoreGlobs.join('\u0000');
  let entry = IGNORE_MATCHER_CACHE.get(key);
  if (entry) return entry;
  entry = {
    matchers: ignoreGlobs
      .filter((g) => typeof g === 'string')
      .map((g) => new Minimatch(g, { dot: true })),
    verdicts: new Map(),
  };
  IGNORE_MATCHER_CACHE.set(key, entry);
  return entry;
}

/**
 * The single ignore-glob test: the full-scope walk and the diff-scope refresh
 * both funnel through it, or an ignored file could poison the
 * `rollup["*"].min` floor in one scope. `{ dot: true }` lets `.agents/`
 * match.
 *
 * @param {string} filePath absolute or relative path to the source file
 * @param {string[]} ignoreGlobs minimatch patterns; empty/absent is a no-op
 * @param {string} [cwd] root for repo-relative resolution; defaults to cwd
 * @returns {boolean} true when the file matches at least one ignore glob
 */
/**
 * @param {string} filePath
 * @param {string} matchCwd
 * @returns {string}
 */
function canonicalRelPath(filePath, matchCwd) {
  const absFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(matchCwd, filePath);
  const rawRel = path.relative(matchCwd, absFilePath).replace(/\\/g, '/');
  return canonicalisePath(rawRel);
}

/**
 * Split out to keep `isIgnoredByGlobs` under the per-method CRAP contract.
 *
 * @param {{matchers: import('minimatch').Minimatch[], verdicts: Map<string, boolean>}} entry
 * @param {string} relPath Canonicalised, POSIX, repo-relative path.
 * @returns {boolean}
 */
function memoisedIgnoreVerdict(entry, relPath) {
  const memoised = entry.verdicts.get(relPath);
  if (memoised !== undefined) return memoised;
  const verdict = entry.matchers.some((m) => m.match(relPath));
  entry.verdicts.set(relPath, verdict);
  return verdict;
}

export function isIgnoredByGlobs(filePath, ignoreGlobs = [], cwd) {
  if (!Array.isArray(ignoreGlobs) || ignoreGlobs.length === 0) return false;
  const matchCwd = cwd ?? process.cwd();
  return memoisedIgnoreVerdict(
    ignoreMatcherEntry(ignoreGlobs),
    canonicalRelPath(filePath, matchCwd),
  );
}

/**
 * Recursively collect scorable source files, using the shared extension set
 * so the walk, coverage freshness and CRAP projection cannot drift apart.
 *
 * @param {string} dir
 * @param {string[]} fileList
 * @param {{ ignoreGlobs?: string[], cwd?: string }} [opts]
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
    } else if (entry.isFile() && isScorableSourceFile(entry.name)) {
      if (isIgnoredByGlobs(filePath, ignoreGlobs, matchCwd)) {
        continue;
      }
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Score files on a worker pool (serial below the cutover, where spawn cost
 * dominates). Output is sorted by path so it is stable across worker timing.
 * Failed and unscorable files are dropped — a phantom `mi: 0` poisons the
 * rollup — but unscorable ones are reported, never silently omitted.
 *
 * @param {string[]} paths
 * @param {{serialThreshold?: number}} [opts] Test seam for the cutover.
 * @returns {Promise<Record<string, number>>}
 */
export async function calculateAll(paths, opts = {}) {
  const serialThreshold = Number.isFinite(opts?.serialThreshold)
    ? opts.serialThreshold
    : SERIAL_THRESHOLD;
  const cwd = process.cwd();
  const indexed = paths.map((p) => ({
    abs: p,
    relPath: path.relative(cwd, p).replace(/\\/g, '/'),
  }));

  let perFile;
  if (indexed.length < serialThreshold) {
    perFile = indexed.map(({ abs, relPath }) => {
      try {
        return { relPath, ...scoreFile(abs) };
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
      return { relPath, ...r };
    });
  }

  perFile.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );

  reportUnscorable(perFile);

  const scores = {};
  for (const { relPath, score } of perFile.filter(isScored)) {
    scores[relPath] = score;
  }
  return scores;
}
