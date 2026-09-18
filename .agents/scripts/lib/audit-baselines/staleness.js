/**
 * Baseline staleness on two clocks: wall-clock age, and commits touching the
 * measured surface since the baseline was committed — a baseline behind its
 * surface is stale at zero days. Unknown reports `null`, never a reassuring 0.
 *
 * @module lib/audit-baselines/staleness
 */

import { execFileCapture } from '../child-exec.js';
import { KIND_SPECS } from './kinds.js';
import { ageInDays } from './read.js';

/**
 * Trimmed stdout, or `null` on failure or empty output.
 *
 * @param {string[]} args
 * @param {{ cwd: string, run?: Function }} io
 * @returns {string | null}
 */
function git(args, { cwd, run }) {
  try {
    const stdout = String(
      execFileCapture('git', args, {
        run,
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

/**
 * `targetDirs`, else path-keyed row ids; non-path kinds get an empty surface
 * rather than a bundle name as a git pathspec.
 *
 * @param {{ kind: string, gateBlock: object | null, rows: Array<{id: string}> }} args
 * @returns {string[]}
 */
function measuredSurfaceOf({ kind, gateBlock, rows }) {
  const dirs = (gateBlock?.targetDirs ?? []).filter(
    (dir) => typeof dir === 'string' && dir.length > 0,
  );
  if (dirs.length > 0) return dirs;
  if (KIND_SPECS[kind]?.idKind !== 'path') return [];
  return [...new Set(rows.map((row) => row.id))];
}

/**
 * Empty surface → `null`: nothing checked, nothing claimed.
 *
 * @param {{ relPath: string, surfacePaths: string[], io: object }} args
 * @returns {number | null}
 */
function commitsSinceBaseline({ relPath, surfacePaths, io }) {
  if (surfacePaths.length === 0) return null;
  const writtenAt = git(['log', '-n1', '--format=%H', '--', relPath], io);
  if (!writtenAt) return null;
  const counted = git(
    ['rev-list', '--count', `${writtenAt}..HEAD`, '--', ...surfacePaths],
    io,
  );
  const commits = Number.parseInt(counted ?? '', 10);
  return Number.isInteger(commits) ? commits : null;
}

/**
 * @param {{
 *   kind: string, gateBlock: object | null, rows: Array<{id: string}>,
 *   relPath: string, baseline: object | null, now: Date,
 *   io: { cwd: string, run?: Function },
 * }} args
 * @returns {{
 *   generatedAt: string | null, staleDays: number | null,
 *   staleCommits: number | null, surfaceStale: boolean | null,
 * }}
 */
export function stalenessOf({
  kind,
  gateBlock,
  rows,
  relPath,
  baseline,
  now,
  io,
}) {
  const generatedAt =
    typeof baseline?.generatedAt === 'string' ? baseline.generatedAt : null;
  const staleCommits = baseline
    ? commitsSinceBaseline({
        relPath,
        surfacePaths: measuredSurfaceOf({ kind, gateBlock, rows }),
        io,
      })
    : null;
  return {
    generatedAt,
    staleDays: ageInDays(generatedAt, now),
    staleCommits,
    surfaceStale: staleCommits === null ? null : staleCommits > 0,
  };
}
