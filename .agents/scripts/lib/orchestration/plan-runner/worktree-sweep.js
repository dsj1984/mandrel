/**
 * plan-runner/worktree-sweep.js — plan-boot sweep that force-removes
 * `.worktrees/story-<id>/` entries whose Story is closed or `agent::done`,
 * after draining the pending-cleanup manifest.
 *
 * `--force` is deliberate: a done Story's branch is already merged, so any
 * residue (dirty artifacts, an interrupted rebase, a Windows lock) is noise;
 * the `WorktreeManager.reap` safety rails are for the active close path.
 */

import path from 'node:path';
import * as defaultGit from '../../git-utils.js';
import { NOOP_LOGGER } from '../../Logger.js';
import { AGENT_LABELS } from '../../label-constants.js';
import { concurrentMap } from '../../util/concurrent-map.js';
import { parseWorktreePorcelain } from '../../worktree/inspector.js';
import { forceDrainPendingCleanup } from '../../worktree/lifecycle/force-drain.js';

const TICKET_READ_CONCURRENCY = 8;

const DONE_LABEL = AGENT_LABELS.DONE;

function isStoryDone(ticket) {
  if (!ticket) return false;
  if (ticket.state === 'closed') return true;
  const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
  return labels.includes(DONE_LABEL);
}

function storyIdFromPath(wtPath) {
  const parts = wtPath.replace(/\\/g, '/').split('/');
  const last = parts[parts.length - 1] ?? '';
  return defaultGit.parseStoryBranch(last);
}

/**
 * Never touches a worktree whose Story is still open.
 *
 * @param {object} opts
 * @param {object} opts.provider    Only `getTicket(id)` is required.
 * @param {string} opts.repoRoot    Absolute path to the main checkout.
 * @param {object} [opts.git]
 * @param {object} [opts.logger]
 * @returns {Promise<{
 *   reaped: Array<{ storyId: number, path: string }>,
 *   skipped: Array<{ storyId: number|null, path: string, reason: string }>,
 * }>}
 */
export async function sweepStaleStoryWorktrees(opts = {}) {
  const ctx = opts.ctx;
  const provider = opts.provider ?? ctx?.provider;
  const repoRoot = opts.repoRoot ?? ctx?.cwd;
  const git = opts.git ?? defaultGit;
  const logger = opts.logger ?? ctx?.logger ?? NOOP_LOGGER;
  const fsRm = opts.fsRm;
  const worktreeRoot = opts.worktreeRoot;
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(
      'sweepStaleStoryWorktrees: provider with getTicket(id) is required',
    );
  }
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('sweepStaleStoryWorktrees: repoRoot is required');
  }

  const resolvedWorktreeRoot =
    worktreeRoot ?? path.join(repoRoot, '.worktrees');

  // Drain the pending-cleanup manifest first so entries whose Windows locks
  // have released self-heal instead of accumulating.
  const drainResult = await forceDrainPendingCleanup({
    repoRoot,
    worktreeRoot: resolvedWorktreeRoot,
    git,
    fsRm,
    logger,
  });

  const reaped = [];
  const skipped = [];

  const listRes = git.gitSpawn(repoRoot, 'worktree', 'list', '--porcelain');
  if (listRes.status !== 0) {
    logger.warn(
      `worktree-sweep: git worktree list failed: ${listRes.stderr || listRes.stdout || 'unknown'}`,
    );
    return { reaped, skipped };
  }

  const entries = parseWorktreePorcelain(listRes.stdout || '');

  // Each mapper captures its own error so one provider hiccup cannot abort
  // the sweep via concurrentMap's first-rejection-wins policy.
  const reads = await concurrentMap(
    entries,
    async (entry) => {
      const wtPath = entry.path;
      if (!wtPath) return { kind: 'no-path' };
      const storyId = storyIdFromPath(wtPath);
      if (storyId === null) return { kind: 'non-story' };
      try {
        const ticket = await provider.getTicket(storyId);
        return { kind: 'ok', wtPath, storyId, ticket };
      } catch (err) {
        return { kind: 'provider-error', wtPath, storyId, error: err };
      }
    },
    { concurrency: TICKET_READ_CONCURRENCY },
  );

  // Removes stay sequential: they mutate .git/worktrees/, and racing git's
  // locking on Windows can leave a partial admin dir the next remove trips on.
  for (const r of reads) {
    if (r.kind === 'no-path' || r.kind === 'non-story') continue;
    if (r.kind === 'provider-error') {
      skipped.push({
        storyId: r.storyId,
        path: r.wtPath,
        reason: `provider-error: ${r.error.message}`,
      });
      logger.warn(
        `worktree-sweep: provider.getTicket(#${r.storyId}) failed: ${r.error.message}`,
      );
      continue;
    }

    if (!isStoryDone(r.ticket)) {
      skipped.push({
        storyId: r.storyId,
        path: r.wtPath,
        reason: 'story-open',
      });
      continue;
    }

    const res = git.gitSpawn(
      repoRoot,
      'worktree',
      'remove',
      '--force',
      r.wtPath,
    );
    if (res.status !== 0) {
      const reason = (
        res.stderr ||
        res.stdout ||
        'worktree-remove-failed'
      ).trim();
      skipped.push({
        storyId: r.storyId,
        path: r.wtPath,
        reason: `remove-failed: ${reason}`,
      });
      logger.warn(
        `worktree-sweep: failed to reap storyId=${r.storyId} path=${r.wtPath}: ${reason}`,
      );
      continue;
    }
    reaped.push({ storyId: r.storyId, path: r.wtPath });
    logger.info(
      `worktree-sweep: reaped stale worktree storyId=${r.storyId} path=${r.wtPath}`,
    );
  }

  git.gitSpawn(repoRoot, 'worktree', 'prune');

  return {
    reaped,
    skipped,
    drainedPending: drainResult.drained,
    persistentPending: drainResult.persistent,
    stillPending: drainResult.stillPending,
  };
}
