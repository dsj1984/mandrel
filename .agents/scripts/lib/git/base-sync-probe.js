/**
 * base-sync-probe.js — under `delivery.close.baseSync: "on-conflict"`, may a
 * Story skip merging `origin/<baseBranch>`? Only a conflict-free merge whose
 * incoming and Story paths are disjoint skips: git then takes every path
 * from the one side that changed it and never runs a merge driver. Any
 * other answer, or any git failure, means merge as usual.
 */

import {
  gitFetchWithRetry as defaultGitFetchWithRetry,
  gitSpawn as defaultGitSpawn,
} from '../git-utils.js';

/** The accepted `delivery.close.baseSync` values; `always` is the default. */
export const BASE_SYNC_MODES = Object.freeze(['always', 'on-conflict']);

function names(res) {
  return (res.stdout ?? '')
    .toString()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `merge-tree` exits 1 on a conflict; any other non-zero is an old git. */
function mergeTreeVerdict(spawn, cwd, origin) {
  const res = spawn(
    cwd,
    'merge-tree',
    '--write-tree',
    '--no-messages',
    origin,
    'HEAD',
  );
  if (res.status === 0) return null;
  return res.status === 1 ? 'conflict' : 'unsupported';
}

/** Raw, rename-free paths each side changed since the merge-base. */
function sidePaths(spawn, cwd, origin) {
  const mb = spawn(cwd, 'merge-base', origin, 'HEAD');
  const mergeBase = (mb.stdout ?? '').toString().trim();
  if (mb.status !== 0 || mergeBase.length === 0) return null;
  const diff = (to) =>
    spawn(cwd, 'diff', '--name-only', '--no-renames', mergeBase, to);
  const incoming = diff(origin);
  const story = diff('HEAD');
  if (incoming.status !== 0 || story.status !== 0) return null;
  return { mergeBase, incoming: names(incoming), story: names(story) };
}

/**
 * @param {{ cwd: string, baseBranch: string, gitSpawn?: typeof defaultGitSpawn, gitFetchWithRetry?: typeof defaultGitFetchWithRetry }} opts
 * @returns {Promise<
 *   | { skip: true, incoming: number, mergeBase: string }
 *   | { skip: false, reason: 'fetch-failed'|'already-current'|'conflict'|'unsupported'|'intersects', path?: string }
 * >}
 */
export async function probeBaseSync({
  cwd,
  baseBranch,
  gitSpawn: spawn = defaultGitSpawn,
  gitFetchWithRetry = defaultGitFetchWithRetry,
}) {
  const origin = `origin/${baseBranch}`;
  const fetch = await gitFetchWithRetry(cwd, 'origin', baseBranch);
  if (fetch.status !== 0) return { skip: false, reason: 'fetch-failed' };
  const current = spawn(cwd, 'merge-base', '--is-ancestor', origin, 'HEAD');
  if (current.status === 0) return { skip: false, reason: 'already-current' };
  const verdict = mergeTreeVerdict(spawn, cwd, origin);
  if (verdict) return { skip: false, reason: verdict };
  const sides = sidePaths(spawn, cwd, origin);
  if (!sides) return { skip: false, reason: 'unsupported' };
  const story = new Set(sides.story);
  const shared = sides.incoming.find((p) => story.has(p));
  if (shared) return { skip: false, reason: 'intersects', path: shared };
  return {
    skip: true,
    incoming: sides.incoming.length,
    mergeBase: sides.mergeBase,
  };
}

/** One human line for a probe answer, naming the decision and its reason. */
export function describeProbe(probe) {
  if (probe.skip) {
    return `skipped — merge is conflict-free and shares no path (${probe.incoming} incoming path(s))`;
  }
  const at = probe.path ? ` (${probe.path})` : '';
  return `merging — probe answered ${probe.reason}${at}`;
}
