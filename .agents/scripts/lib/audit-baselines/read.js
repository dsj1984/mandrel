/**
 * Tolerant, strictly read-only fs access: a missing or malformed file is
 * evidence for the envelope, never a throw.
 *
 * @module lib/audit-baselines/read
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} absolutePath
 * @returns {{ exists: boolean, parsed: object | null, parseError: string | null }}
 */
export function readJsonFile(absolutePath) {
  let raw;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return { exists: false, parsed: null, parseError: null };
  }
  try {
    return { exists: true, parsed: JSON.parse(raw), parseError: null };
  } catch (err) {
    return {
      exists: true,
      parsed: null,
      parseError: err?.message ?? String(err),
    };
  }
}

/**
 * @param {string} repoRoot
 * @param {string} rootDir repo-relative directory to walk
 * @returns {string[]} sorted repo-relative posix paths
 */
export function listFilesUnder(repoRoot, rootDir) {
  const skip = new Set(['node_modules', '.git', '.worktrees']);
  const out = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        out.push(path.relative(repoRoot, child).split(path.sep).join('/'));
      }
    }
  };
  walk(path.resolve(repoRoot, rootDir));
  return out.sort();
}

/**
 * Whole days; `null` (unknown) rather than a fabricated 0.
 *
 * @param {unknown} generatedAt
 * @param {Date} now
 * @returns {number | null}
 */
export function ageInDays(generatedAt, now) {
  if (typeof generatedAt !== 'string') return null;
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}
