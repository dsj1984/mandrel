/**
 * plan-runner/worktree-sweep.js — boot sweep that removes
 * `.worktrees/story-<id>/` entries whose Story is closed or `agent::done`,
 * after draining the pending-cleanup manifest. Called by `runBootSweep`
 * (`boot-sweep.js`) under the shared merged-branch sweep lock.
 *
 * Removal goes through `removeWorktreeWithRecovery` — the same seam close
 * uses: Windows lock retries, an `fs.rm` fallback that discards residue a
 * done Story's merged branch no longer needs, and the pending-cleanup
 * hand-off when that exhausts. Branches are never deleted here; the
 * merged-branch sweep owns them.
 *
 * Two trees are never touched: an open Story's, and the one the running
 * process was loaded from or is working in (`findRunningCodeInside`).
 */

import path from 'node:path';
import * as defaultGit from '../../git-utils.js';
import { NOOP_LOGGER } from '../../Logger.js';
import { AGENT_LABELS } from '../../label-constants.js';
import { concurrentMap } from '../../util/concurrent-map.js';
import { canonicalPath } from '../../worktree/canonical-path.js';
import { parseWorktreePorcelain, samePath } from '../../worktree/inspector.js';
import { forceDrainPendingCleanup } from '../../worktree/lifecycle/force-drain.js';
import {
  findRunningCodeInside,
  removeWorktreeWithRecovery,
} from '../../worktree/lifecycle/reap.js';

const TICKET_READ_CONCURRENCY = 8;

const DONE_LABEL = AGENT_LABELS.DONE;

function isStoryDone(ticket) {
  if (!ticket) return false;
  if (ticket.state === 'closed') return true;
  const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
  return labels.includes(DONE_LABEL);
}

/**
 * The Story id of a `<worktreeRoot>/story-<id>` entry, else `null` — a
 * `story-<id>` directory anywhere else (e.g. `.claude/worktrees/`) is not
 * this sweep's to judge.
 *
 * @param {string} wtPath
 * @param {string} worktreeRoot
 * @param {string} platform
 * @returns {number|null}
 */
function storyIdFromPath(wtPath, worktreeRoot, platform) {
  const parent = path.dirname(canonicalPath(wtPath));
  if (!samePath(parent, canonicalPath(worktreeRoot), platform)) return null;
  return defaultGit.parseStoryBranch(path.basename(path.resolve(wtPath)));
}

/**
 * Validate and normalise the options bag.
 *
 * @param {object} opts
 * @returns {object}
 */
function resolveSweepOptions(opts) {
  const ctx = opts.ctx;
  const provider = opts.provider ?? ctx?.provider;
  const repoRoot = opts.repoRoot ?? ctx?.cwd;
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(
      'sweepStaleStoryWorktrees: provider with getTicket(id) is required',
    );
  }
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('sweepStaleStoryWorktrees: repoRoot is required');
  }
  const platform = opts.platform ?? process.platform;
  return {
    provider,
    repoRoot,
    platform,
    git: opts.git ?? defaultGit,
    logger: opts.logger ?? ctx?.logger ?? NOOP_LOGGER,
    fsRm: opts.fsRm,
    sleepFn: opts.sleepFn,
    worktreeRoot: path.resolve(
      opts.worktreeRoot ?? path.join(repoRoot, '.worktrees'),
    ),
    guardPaths: [process.cwd(), ...(opts.runningPaths ?? [])],
  };
}

/**
 * Read every Story worktree's ticket; each mapper captures its own error so
 * one provider hiccup cannot abort the sweep via concurrentMap's
 * first-rejection-wins policy.
 */
function readStoryTickets(entries, o) {
  return concurrentMap(
    entries,
    async (entry) => {
      const wtPath = entry.path;
      const storyId = wtPath
        ? storyIdFromPath(wtPath, o.worktreeRoot, o.platform)
        : null;
      if (storyId === null) return { kind: 'non-story' };
      try {
        const ticket = await o.provider.getTicket(storyId);
        return { kind: 'ok', wtPath, storyId, ticket };
      } catch (err) {
        return { kind: 'provider-error', wtPath, storyId, error: err };
      }
    },
    { concurrency: TICKET_READ_CONCURRENCY },
  );
}

/**
 * Why a read entry must be kept, or `null` when it may be removed.
 *
 * @returns {string|null}
 */
function keepReason(r, o) {
  if (r.kind === 'provider-error') {
    o.logger.warn(
      `worktree-sweep: provider.getTicket(#${r.storyId}) failed: ${r.error.message}`,
    );
    return `provider-error: ${r.error.message}`;
  }
  if (!isStoryDone(r.ticket)) return 'story-open';
  const selfPath = findRunningCodeInside(o, r.wtPath, o.guardPaths);
  if (selfPath) {
    o.logger.warn(
      `worktree-sweep: skipped storyId=${r.storyId} path=${r.wtPath} — the running process uses it (${selfPath})`,
    );
    return 'running-from-target-tree';
  }
  return null;
}

async function removeOne(r, o) {
  const ctx = {
    repoRoot: o.repoRoot,
    git: o.git,
    logger: o.logger,
    platform: o.platform,
    worktreeRoot: o.worktreeRoot,
    listCache: { list: null, ts: 0 },
    fsRm: o.fsRm,
  };
  const res = await removeWorktreeWithRecovery(ctx, r.wtPath, {
    storyId: r.storyId,
    ...(o.sleepFn ? { sleepFn: o.sleepFn, retryDelay: 0 } : {}),
  });
  return res.removed
    ? null
    : `remove-failed: ${res.reason ?? 'worktree-remove-failed'}`;
}

/**
 * Never touches a worktree whose Story is still open, nor the one the
 * running process uses.
 *
 * @param {object} opts
 * @param {object} opts.provider    Only `getTicket(id)` is required.
 * @param {string} opts.repoRoot    Absolute path to the main checkout.
 * @param {object} [opts.git]
 * @param {object} [opts.logger]
 * @param {string[]} [opts.runningPaths] Extra paths the running process owns.
 * @returns {Promise<{
 *   reaped: Array<{ storyId: number, path: string }>,
 *   skipped: Array<{ storyId: number|null, path: string, reason: string }>,
 * }>}
 */
export async function sweepStaleStoryWorktrees(opts = {}) {
  const o = resolveSweepOptions(opts);

  // Drain the pending-cleanup manifest first so entries whose Windows locks
  // have released self-heal instead of accumulating.
  const drainResult = await forceDrainPendingCleanup({
    repoRoot: o.repoRoot,
    worktreeRoot: o.worktreeRoot,
    git: o.git,
    fsRm: o.fsRm,
    logger: o.logger,
  });

  const reaped = [];
  const skipped = [];

  const listRes = o.git.gitSpawn(o.repoRoot, 'worktree', 'list', '--porcelain');
  if (listRes.status !== 0) {
    o.logger.warn(
      `worktree-sweep: git worktree list failed: ${listRes.stderr || listRes.stdout || 'unknown'}`,
    );
    return { reaped, skipped };
  }

  const reads = await readStoryTickets(
    parseWorktreePorcelain(listRes.stdout || ''),
    o,
  );

  // Removes stay sequential: they mutate .git/worktrees/, and racing git's
  // locking on Windows can leave a partial admin dir the next remove trips on.
  for (const r of reads) {
    if (r.kind === 'non-story') continue;
    const reason = keepReason(r, o) ?? (await removeOne(r, o));
    if (reason) {
      skipped.push({ storyId: r.storyId, path: r.wtPath, reason });
      continue;
    }
    reaped.push({ storyId: r.storyId, path: r.wtPath });
    o.logger.info(
      `worktree-sweep: reaped stale worktree storyId=${r.storyId} path=${r.wtPath}`,
    );
  }

  o.git.gitSpawn(o.repoRoot, 'worktree', 'prune');

  return {
    reaped,
    skipped,
    drainedPending: drainResult.drained,
    persistentPending: drainResult.persistent,
    stillPending: drainResult.stillPending,
  };
}
