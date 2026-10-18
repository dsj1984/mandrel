/**
 * Join each Story's landed diff size onto agent-cost rows (Story #5766).
 * A Story lands as one squash commit on the base branch whose subject carries
 * `(refs #<id>)`; its `git show --shortstat` gives files / insertions /
 * deletions. Offline and local — no GitHub API.
 */

import { gitSpawn } from '../../../.agents/scripts/lib/git-utils.js';

/**
 * @typedef {object} DeliveredDiff
 * @property {string} sha
 * @property {number} files
 * @property {number} insertions
 * @property {number} deletions
 */

/**
 * @typedef {(args: string[]) => string|null} GitFn
 *   Runs git with `args`; trimmed stdout on success, null on failure.
 */

/**
 * The default git seam: `gitSpawn` at `cwd`, stdout on exit 0, else null.
 *
 * @param {string} cwd
 * @returns {GitFn}
 */
export function defaultGitFn(cwd) {
  return (args) => {
    const result = gitSpawn(cwd, ...args);
    return result.status === 0 ? result.stdout : null;
  };
}

/**
 * Parse a `git show --shortstat --format=` line, e.g.
 * ` 16 files changed, 506 insertions(+), 71 deletions(-)`.
 *
 * @param {string} text
 * @returns {{ files: number, insertions: number, deletions: number }}
 */
export function parseShortstat(text) {
  const count = (pattern) => {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : 0;
  };
  return {
    files: count(/(\d+) files? changed/),
    insertions: count(/(\d+) insertions?\(\+\)/),
    deletions: count(/(\d+) deletions?\(-\)/),
  };
}

/**
 * Resolve one Story's landed squash commit on `baseRef`.
 *
 * @param {number} storyId
 * @param {{ gitFn: GitFn, baseRef: string }} opts
 * @returns {DeliveredDiff|null} null when no first-parent commit matches
 */
export function resolveDelivered(storyId, { gitFn, baseRef }) {
  const sha = gitFn([
    'log',
    '--first-parent',
    '--fixed-strings',
    `--grep=(refs #${storyId})`,
    '--format=%H',
    '-n',
    '1',
    baseRef,
  ]);
  if (!sha) return null;
  const stat = gitFn(['show', '--shortstat', '--format=', sha]);
  if (stat == null) return null;
  return { sha, ...parseShortstat(stat) };
}

/**
 * Attach `delivered` to every row, resolving each distinct storyId once.
 * A missing base ref degrades every row to `delivered: null` with one
 * warning; it never throws.
 *
 * @template {{ storyId: number|null }} R
 * @param {R[]} rows
 * @param {{ gitFn: GitFn, baseRef: string,
 *   stderr?: { write: (s: string) => unknown } }} opts
 * @returns {(R & { delivered: DeliveredDiff|null })[]}
 */
export function attachDelivered(rows, { gitFn, baseRef, stderr }) {
  const storyIds = [
    ...new Set(rows.map((r) => r.storyId).filter((id) => id != null)),
  ];
  const cache = new Map();
  if (storyIds.length > 0) {
    const baseOk = gitFn([
      'rev-parse',
      '--verify',
      '--quiet',
      `${baseRef}^{commit}`,
    ]);
    if (!baseOk) {
      stderr?.write(
        `[agent-cost-report] base ref not found: ${baseRef}; delivered is null for every row\n`,
      );
    } else {
      for (const id of storyIds) {
        cache.set(id, resolveDelivered(id, { gitFn, baseRef }));
      }
      const unlanded = storyIds.filter((id) => cache.get(id) == null);
      if (unlanded.length > 0) {
        stderr?.write(
          `[agent-cost-report] no landed commit on ${baseRef} for Story ${unlanded.map((id) => `#${id}`).join(', ')}\n`,
        );
      }
    }
  }
  return rows.map((row) => ({
    ...row,
    delivered: cache.get(row.storyId) ?? null,
  }));
}
