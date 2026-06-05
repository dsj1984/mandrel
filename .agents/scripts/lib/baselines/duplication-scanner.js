/**
 * duplication-scanner.js — code-duplication (DRY) scanner for the
 * duplication baseline (Story #3664).
 *
 * Wraps the jscpd clone detector behind two pure-ish seams so the
 * refresh script and its unit tests can exercise the parse→envelope path
 * without spawning a real scan:
 *
 *   - `buildDuplicationRows(clones, fileLineCounts, cwd)` — PURE. Folds
 *     jscpd's clone-pair output into per-file `{ path, duplicatedLines,
 *     totalLines, percentage }` rows. Overlapping clones on the same file
 *     are unioned (line-set), so a line duplicated by two different clones
 *     counts once. Every file the scan visited gets a row — files with no
 *     clones land at `duplicatedLines: 0` so the baseline records the full
 *     denominator and a later regression on a previously-clean file is
 *     visible.
 *
 *   - `scanDuplication({ targetDirs, cwd, minTokens, detect, readLineCount })`
 *     — the I/O wrapper. Walks `targetDirs`, runs the injected `detect`
 *     (jscpd's `detectClones` by default), reads per-file line counts, and
 *     returns the projected rows. The `detect` and `readLineCount` seams
 *     are injectable so tests run fully offline.
 *
 * Lower duplication is better — see `kinds/duplication.js` and the gate's
 * `lte` floor direction in `check-baselines/phases/floors.js`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_MIN_TOKENS = 50;
const DEFAULT_FORMATS = Object.freeze(['javascript']);

/**
 * Normalise a jscpd `sourceId` (or any path) to a canonical POSIX
 * repo-relative path. jscpd already emits cwd-relative paths, but a future
 * jscpd bump (or an absolute `sourceId`) is defended against here.
 *
 * @param {string} sourceId
 * @param {string} cwd
 * @returns {string}
 */
export function relativisePath(sourceId, cwd) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) return sourceId;
  const rel = path.isAbsolute(sourceId)
    ? path.relative(cwd, sourceId)
    : sourceId;
  return rel.split(path.sep).join('/');
}

/**
 * Count the inclusive line span a clone covers: `end.line - start.line + 1`.
 * jscpd reports 1-based line numbers; a single-line clone spans one line.
 *
 * @param {{ start?: { line?: number }, end?: { line?: number } }} dup
 * @returns {Array<number>} the 1-based line numbers the clone covers
 */
function cloneLineNumbers(dup) {
  const start = dup?.start?.line;
  const end = dup?.end?.line;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const lines = [];
  for (let n = lo; n <= hi; n += 1) lines.push(n);
  return lines;
}

/**
 * PURE: fold jscpd clone pairs + per-file line counts into canonical
 * duplication rows. Both sides of every clone pair (`duplicationA` and
 * `duplicationB`) contribute their covered lines to their respective
 * file's duplicated-line set, so a file that is only ever the "B" side of
 * a clone still accrues duplication.
 *
 * @param {Array<{duplicationA?: object, duplicationB?: object}>} clones
 * @param {Map<string, number>|Record<string, number>} fileLineCounts
 *   per-file total line counts keyed by canonical POSIX repo-relative path
 * @param {string} [cwd] used to relativise absolute sourceIds
 * @returns {Array<{path: string, duplicatedLines: number, totalLines: number, percentage: number}>}
 */
export function buildDuplicationRows(
  clones,
  fileLineCounts,
  cwd = process.cwd(),
) {
  const counts = toLineCountMap(fileLineCounts);
  const dupLinesByFile = new Map();
  // Seed every visited file with an empty set so clean files get a 0-row.
  for (const file of counts.keys()) {
    dupLinesByFile.set(file, new Set());
  }
  for (const clone of clones ?? []) {
    for (const side of [clone?.duplicationA, clone?.duplicationB]) {
      if (!side) continue;
      const file = relativisePath(side.sourceId, cwd);
      if (!file) continue;
      const set = dupLinesByFile.get(file) ?? new Set();
      for (const line of cloneLineNumbers(side)) set.add(line);
      dupLinesByFile.set(file, set);
    }
  }
  const rows = [];
  for (const [file, lineSet] of dupLinesByFile) {
    const totalLines = counts.get(file) ?? 0;
    const duplicatedLines = lineSet.size;
    const percentage =
      totalLines > 0 ? (duplicatedLines / totalLines) * 100 : 0;
    rows.push({
      path: file,
      duplicatedLines,
      totalLines,
      percentage: Number(percentage.toFixed(2)),
    });
  }
  return rows;
}

function toLineCountMap(fileLineCounts) {
  if (fileLineCounts instanceof Map) return fileLineCounts;
  const map = new Map();
  if (fileLineCounts && typeof fileLineCounts === 'object') {
    for (const [k, v] of Object.entries(fileLineCounts)) {
      map.set(k, Number(v) || 0);
    }
  }
  return map;
}

/**
 * Default per-file line counter — reads the file off disk and counts
 * newline-delimited lines. Injectable via `scanDuplication`'s
 * `readLineCount` seam so tests never touch the filesystem.
 *
 * @param {string} absPath
 * @returns {number}
 */
export function readLineCount(absPath) {
  const text = readFileSync(absPath, 'utf8');
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline produces a final empty element — drop it so the
  // count matches the editor's line count.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Run a duplication scan over `targetDirs` and return canonical rows.
 *
 * @param {{
 *   targetDirs: string[],
 *   cwd?: string,
 *   minTokens?: number,
 *   formats?: string[],
 *   ignoreGlobs?: string[],
 *   detect: (opts: object) => Promise<Array<object>>,
 *   readLineCount?: (absPath: string) => number,
 * }} params
 * @returns {Promise<Array<{path: string, duplicatedLines: number, totalLines: number, percentage: number}>>}
 */
export async function scanDuplication({
  targetDirs,
  cwd = process.cwd(),
  minTokens = DEFAULT_MIN_TOKENS,
  formats = DEFAULT_FORMATS,
  ignoreGlobs = [],
  detect,
  readLineCount: readLineCountFn = readLineCount,
}) {
  if (typeof detect !== 'function') {
    throw new TypeError('scanDuplication: detect must be a function');
  }
  const dirs = Array.isArray(targetDirs) ? targetDirs : [];
  const clones = await detect({
    path: dirs,
    cwd,
    silent: true,
    gitignore: false,
    reporters: [],
    format: formats,
    minTokens,
    ignore: Array.isArray(ignoreGlobs) ? ignoreGlobs : [],
  });
  const visited = collectVisitedFiles(clones, cwd);
  const fileLineCounts = new Map();
  for (const rel of visited) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    try {
      fileLineCounts.set(rel, readLineCountFn(abs));
    } catch {
      // Unreadable file — record 0 so it never poisons the denominator.
      fileLineCounts.set(rel, 0);
    }
  }
  return buildDuplicationRows(clones, fileLineCounts, cwd);
}

/**
 * Collect the set of files that appear on either side of any clone pair.
 * jscpd's `detectClones` only reports files that participate in at least
 * one clone, so the scanned-but-clean files are not enumerable from the
 * clone list alone — the baseline therefore records exactly the files
 * with detected duplication. Pure helper, exported for tests.
 *
 * @param {Array<object>} clones
 * @param {string} cwd
 * @returns {string[]} canonical POSIX repo-relative paths, deduped + sorted
 */
export function collectVisitedFiles(clones, cwd = process.cwd()) {
  const set = new Set();
  for (const clone of clones ?? []) {
    for (const side of [clone?.duplicationA, clone?.duplicationB]) {
      if (!side) continue;
      const file = relativisePath(side.sourceId, cwd);
      if (file) set.add(file);
    }
  }
  return [...set].sort();
}
