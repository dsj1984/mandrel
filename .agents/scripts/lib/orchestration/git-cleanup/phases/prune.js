/**
 * prune.js — prune-remotes phase of git-cleanup (Story #2466).
 *
 * Owns `executePrune(ctx)` and the pure `parsePrunedRefs(output, remoteName)`
 * helper that consumes `git fetch --prune` stderr. Both exports are
 * preserved byte-identically from `git-cleanup.js`.
 *
 * @module lib/orchestration/git-cleanup/phases/prune
 */

import { Logger } from '../../../Logger.js';
import { pruneRemoteTracking } from './git-probes.js';

const TAG = '[git-cleanup]';

/**
 * Pure: extract the short ref names from `git fetch --prune` stderr.
 */
export function parsePrunedRefs(output, remoteName) {
  const prefix = `${remoteName}/`;
  const out = [];
  for (const raw of (output ?? '').split('\n')) {
    const line = raw.trim();
    let m = line.match(/^-\s+\[deleted\]\s+\S+\s+->\s+(.+)$/);
    if (!m) m = line.match(/^\*\s+\[pruned\]\s+(.+)$/);
    if (!m) continue;
    const ref = m[1].trim();
    out.push(ref.startsWith(prefix) ? ref.slice(prefix.length) : ref);
  }
  return out;
}

/**
 * Execute the prune-remotes phase. Thin wrapper around
 * `pruneRemoteTracking` so the orchestrator can treat it uniformly with
 * the other phases.
 */
export function executePrune(ctx) {
  const {
    cwd,
    remoteName = 'origin',
    pruneFn = (c, r) => pruneRemoteTracking(c, r, parsePrunedRefs),
    logger = Logger,
  } = ctx;
  const res = pruneFn(cwd, remoteName);
  if (!res.ok) {
    logger.warn?.(`${TAG} ❌ prune ${remoteName} failed: ${res.stderr}`);
    return {
      ok: false,
      attempted: true,
      remote: remoteName,
      pruned: [],
      stderr: res.stderr,
    };
  }
  if ((res.pruned ?? []).length === 0) {
    logger.info?.(`${TAG} ✅ prune ${remoteName} (no stale refs)`);
  } else {
    logger.info?.(
      `${TAG} ✅ prune ${remoteName} (dropped ${res.pruned.length} stale ref(s))`,
    );
  }
  return {
    ok: true,
    attempted: true,
    remote: remoteName,
    pruned: res.pruned ?? [],
  };
}
