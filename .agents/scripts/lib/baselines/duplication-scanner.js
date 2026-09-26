/**
 * jscpd-backed scanner for the duplication baseline (lower is better).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveDependencyVersion } from '../dependency-version.js';

const DEFAULT_MIN_TOKENS = 50;
const DEFAULT_FORMATS = Object.freeze(['javascript']);

const require = createRequire(import.meta.url);

/** jscpd 5 is a Rust rewrite with no Node API; only major 4 exposes one. */
const SUPPORTED_JSCPD_MAJOR = '^4';

/**
 * Lazy CJS load: jscpd's ESM entry has a broken transitive `colors/safe`
 * specifier under strict ESM resolution, and importers that never scan should
 * not pay the load.
 *
 * A resolved jscpd without `detectClones` is an unsupported major, not a
 * missing install — the error names the version so the fix is obvious.
 *
 * @param {NodeJS.Require} [requireFn] substitutes the module resolver
 * @returns {(opts: object) => Promise<Array<object>>}
 */
export function resolveDetectClones(requireFn = require) {
  const jscpd = requireFn('jscpd');
  if (typeof jscpd?.detectClones !== 'function') {
    const version = resolveDependencyVersion('jscpd', requireFn) ?? 'unknown';
    throw new Error(
      `[Duplication] jscpd ${version} exposes no detectClones Node API — ` +
        `the duplication gate supports jscpd ${SUPPORTED_JSCPD_MAJOR}; install jscpd@${SUPPORTED_JSCPD_MAJOR}`,
    );
  }
  return jscpd.detectClones;
}

/**
 * POSIX repo-relative path, defending against an absolute `sourceId`.
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
 * jscpd occasionally reports a side with `end.line < start.line` (its `range`
 * and `fragment` are inverted too). The real span is unrecoverable, and
 * widening it to `[end, start]` recorded hundreds of phantom lines, so such a
 * side counts nothing — under-counting one clone beats inventing a span.
 *
 * @param {{ start?: { line?: number }, end?: { line?: number } }} dup
 * @returns {Array<number>} the 1-based line numbers the clone covers
 */
function cloneLineNumbers(dup) {
  const start = dup?.start?.line;
  const end = dup?.end?.line;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
  const lines = [];
  for (let n = start; n <= end; n += 1) lines.push(n);
  return lines;
}

/**
 * Pure. Both sides of each clone pair accrue lines; overlapping clones are
 * unioned per file so a line counts once. Every counted file gets a row.
 *
 * @param {Array<{duplicationA?: object, duplicationB?: object}>} clones
 * @param {Map<string, number>|Record<string, number>} fileLineCounts
 * @param {string} [cwd]
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
 * @param {string} absPath
 * @returns {number}
 */
export function readLineCount(absPath) {
  const text = readFileSync(absPath, 'utf8');
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  // Drop the empty element after a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
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
 * Files on either side of any clone. jscpd reports only participating files,
 * so the baseline records exactly the files with detected duplication.
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
