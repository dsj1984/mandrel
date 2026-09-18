/**
 * lib/orchestration/diff-magnitude.js — changed-line magnitude of a diff,
 * split into implementation and mandated-companion (tests, docs, baselines,
 * lockfiles) halves, so obeying test-first and doc rules never inflates the
 * size that bounds the light path.
 *
 * Contracts: lines are additions + deletions, never net (a big deletion is
 * not trivial); a pure rename is free but its file still counts; exemption
 * is from counting, never from sensitive-path risk. Companion globs are a
 * positive list — a `!` picomatch pattern widens rather than narrows. Every
 * export is total.
 *
 * @module lib/orchestration/diff-magnitude
 */

import { matchesAnyFilePattern } from '../audit-suite/selector.js';
import { gitSpawn } from '../git-utils.js';

/**
 * Mandated-companion paths, exempt from implementation counts. Deliberately
 * absent: `.agentrc.json`, `.agents/schemas/**` (incl. the sensitive-path
 * SSOT), `.github/workflows/**`, `package.json` — behavior by effect.
 * `baselines/**` is root-anchored, so baseline schemas still count. Markdown
 * (incl. workflows/rules) is exempt; its guards are the close-time doc gates.
 */
const COMPANION_PATH_GLOBS = Object.freeze([
  '**/__tests__/**',
  '**/*.test.js',
  '**/*.test.mjs',
  '**/*.test.cjs',
  '**/*.test.ts',
  '**/*.test.tsx',
  'tests/**',
  'features/**',
  'docs/**',
  '**/*.md',
  'baselines/**',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

/**
 * Resolve a numstat rename (`old => new` or `dir/{old => new}/f.js`) to its
 * destination.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeNumstatPath(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return '';
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(value);
  if (braced) {
    const [, prefix, , to, suffix] = braced;
    return `${prefix}${to}${suffix}`.replace(/\/{2,}/g, '/');
  }
  const arrow = value.split(' => ');
  return (arrow.length > 1 ? arrow[arrow.length - 1] : value).trim();
}

/**
 * Parse numstat rows. Binary rows count zero lines; any malformed line
 * returns `null` ("magnitude unknown").
 *
 * @param {unknown} stdout
 * @returns {Array<{ additions: number, deletions: number, path: string }>|null}
 */
function parseNumstatRows(stdout) {
  if (typeof stdout !== 'string') return null;
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmedEnd = line.replace(/\s+$/, '');
    if (trimmedEnd.length === 0) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(trimmedEnd);
    if (!match) return null;
    rows.push({
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      path: normalizeNumstatPath(match[3]),
    });
  }
  return rows;
}

/**
 * A throwing matcher yields `false` (implementation): a classification
 * failure must never shrink the magnitude.
 *
 * @param {unknown} file
 * @param {{ matchFn?: typeof matchesAnyFilePattern }} [deps]
 * @returns {boolean}
 */
function isCompanionPath(file, { matchFn = matchesAnyFilePattern } = {}) {
  if (typeof file !== 'string' || file.trim() === '') return false;
  try {
    return matchFn(COMPANION_PATH_GLOBS, [file.trim()]) === true;
  } catch {
    return false;
  }
}

/**
 * Numstat rows for `baseRef...headRef`; `null` on any failure.
 *
 * @param {{
 *   baseRef?: string,
 *   headRef?: string,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} [args]
 * @returns {Array<{ additions: number, deletions: number, path: string }>|null}
 */
export function readNumstatRows({
  baseRef,
  headRef,
  cwd = process.cwd(),
  gitSpawnFn = gitSpawn,
} = {}) {
  if (typeof baseRef !== 'string' || baseRef.length === 0) return null;
  if (typeof headRef !== 'string' || headRef.length === 0) return null;
  try {
    const result = gitSpawnFn(
      cwd,
      'diff',
      '--numstat',
      `${baseRef}...${headRef}`,
    );
    if (!result || result.status !== 0) return null;
    return parseNumstatRows(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Summarize magnitude. Files come from `change-set.js`'s canonical
 * enumeration, lines from numstat. `null` (unknown, distinct from zero)
 * when either input is unusable.
 *
 * @param {{
 *   changedFiles?: unknown,
 *   rows?: unknown,
 *   isCompanionFn?: typeof isCompanionPath,
 * }} [args]
 * @returns {{
 *   implFiles: number,
 *   implLines: number,
 *   companionFiles: number,
 *   companionLines: number,
 *   totalFiles: number,
 * }|null}
 */
export function summarizeDiffMagnitude({
  changedFiles,
  rows,
  isCompanionFn = isCompanionPath,
} = {}) {
  if (!Array.isArray(changedFiles) || !Array.isArray(rows)) return null;
  const files = changedFiles.filter(
    (f) => typeof f === 'string' && f.trim() !== '',
  );

  // Guarded again so an injected classifier cannot break totality.
  const isCompanion = (file) => {
    try {
      return isCompanionFn(file) === true;
    } catch {
      return false;
    }
  };

  let implFiles = 0;
  for (const file of files) {
    if (!isCompanion(file)) implFiles += 1;
  }

  let implLines = 0;
  let companionLines = 0;
  for (const row of rows) {
    const lines = (row?.additions ?? 0) + (row?.deletions ?? 0);
    if (isCompanion(row?.path)) companionLines += lines;
    else implLines += lines;
  }

  return {
    implFiles,
    implLines,
    companionFiles: files.length - implFiles,
    companionLines,
    totalFiles: files.length,
  };
}
