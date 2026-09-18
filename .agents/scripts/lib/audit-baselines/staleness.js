/**
 * staleness.js — the two clocks a baseline is stale against (Story #4962).
 *
 * Wall-clock age answers the wrong question on a busy repository.
 * `coverage.json` and `maintainability.json` both read `staleDays: 0` while
 * already predating merges that had rescored files they still carry rows for:
 * refreshed an hour ago, and behind already. The second clock is the one that
 * matters — how many commits have touched the **measured surface** since the
 * baseline was last committed. A baseline older than the surface it scores is
 * stale at zero wall-clock days.
 *
 * Read-only and degrading, like the rest of this engine: a shallow clone, an
 * untracked baseline, or a surface that is not path-keyed all report `null`.
 * Unknown is never rounded down to a reassuring 0.
 *
 * @module lib/audit-baselines/staleness
 */

import { execFileCapture } from '../child-exec.js';
import { KIND_SPECS } from './kinds.js';
import { ageInDays } from './read.js';

/**
 * Run a git command under `cwd`, returning trimmed stdout, or `null` on any
 * failure or empty result. Buffer and shell policy come from the shared
 * child-process surface ([`child-exec.js`](../child-exec.js)).
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
 * The repo-relative paths whose commits would invalidate this baseline: the
 * gate's declared `targetDirs` when it has them, else the baseline's own row
 * ids — which are file paths for every kind but `bundle-size` (bundle
 * names). That one gets an empty surface rather than a bundle name handed to
 * git as a pathspec.
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
 * Commits touching `surfacePaths` since `relPath` was last committed. An
 * empty surface yields `null` too: nothing was checked, so nothing can be
 * claimed.
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
 * The four staleness fields of one `gateSurface[]` entry, on both clocks.
 *
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
