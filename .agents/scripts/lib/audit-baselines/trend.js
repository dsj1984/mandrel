/**
 * Per-kind rollup direction of travel, read from each baseline's own git
 * history — never recomputed. Any git failure yields no trend entry: missing
 * history is missing evidence, not an error.
 *
 * @module lib/audit-baselines/trend
 */

import { execFileCapture } from '../child-exec.js';
import { trendRollupOf } from './kinds.js';

/**
 * Newest first.
 *
 * @param {{ cwd: string, relPath: string, limit: number, run?: Function }} args
 * @returns {Array<{ sha: string, committedAt: string }>}
 */
function listCommits({ cwd, relPath, limit, run }) {
  let stdout;
  try {
    stdout = execFileCapture(
      'git',
      ['log', `-n${limit}`, '--format=%H %cI', '--', relPath],
      { run, cwd, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return [];
  }
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(' '))
    .map((line) => {
      const [sha, committedAt] = line.split(' ');
      return { sha, committedAt };
    });
}

/**
 * @param {{ cwd: string, kind: string, sha: string, relPath: string, run?: Function }} args
 * @returns {object | null}
 */
function rollupAt({ cwd, kind, sha, relPath, run }) {
  let stdout;
  try {
    stdout = execFileCapture('git', ['show', `${sha}:${relPath}`], {
      run,
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  try {
    return trendRollupOf(kind, JSON.parse(stdout));
  } catch {
    return null;
  }
}

/**
 * `to - from` per axis; an axis missing on either side is omitted, since an
 * invented delta would read as a regression.
 *
 * @param {object} from
 * @param {object} to
 * @returns {Record<string, number>}
 */
function rollupDelta(from, to) {
  const deltas = {};
  for (const [axis, current] of Object.entries(to ?? {})) {
    const previous = from?.[axis];
    if (typeof current === 'number' && typeof previous === 'number') {
      deltas[axis] = current - previous;
    }
  }
  return deltas;
}

/**
 * Newest-vs-previous rollup deltas per kind.
 *
 * @param {{
 *   cwd: string, kinds: string[], pathFor: (kind: string) => string,
 *   depth?: number, run?: Function,
 * }} args
 * @returns {Array<object>}
 */
export function buildTrend({ cwd, kinds, pathFor, depth = 5, run }) {
  const out = [];
  for (const kind of kinds) {
    const relPath = pathFor(kind);
    const commits = listCommits({ cwd, relPath, limit: depth, run });
    const samples = [];
    for (const commit of commits) {
      const rollup = rollupAt({ cwd, kind, sha: commit.sha, relPath, run });
      if (rollup) samples.push({ ...commit, rollup });
    }
    if (samples.length < 2) continue;
    const [current, previous] = samples;
    out.push({
      kind,
      baselinePath: relPath,
      sampleCount: samples.length,
      from: { sha: previous.sha, committedAt: previous.committedAt },
      to: { sha: current.sha, committedAt: current.committedAt },
      deltas: rollupDelta(previous.rollup, current.rollup),
    });
  }
  return out;
}
