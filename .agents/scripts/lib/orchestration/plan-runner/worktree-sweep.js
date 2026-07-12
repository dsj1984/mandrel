/**
 * plan-runner/worktree-sweep.js
 *
 * Reap-sweep run at plan boot (via `drainPendingCleanupAtBoot` in
 * `lib/orchestration/epic-plan-spec/phases/drain.js`, wired into
 * `plan-persist.js`). Iterates the `.worktrees/story-<id>/`
 * entries registered with git, looks up each parent Story, and force-removes
 * any whose Story is already closed or labeled `agent::done`.
 *
 * The `--force` flag is intentional. By the time a Story is `agent::done`
 * its branch has already been merged into the Epic branch (via
 * `story-close.js`), so any residue left in the worktree — dirty
 * build artifacts, an interrupted rebase, a stray Windows lock — is noise.
 * The safety rails in `WorktreeManager.reap` exist for the _active_ close
 * path; at plan time we already know the Story is done and want the
 * directory gone no matter what.
 *
 * Public API:
 *   - `sweepStaleStoryWorktrees({ provider, repoRoot, git?, logger?, fsRm?, worktreeRoot? })`
 *
 * Also drains any `.worktrees/.pending-cleanup.json` manifest left behind
 * by Stage 1 (`removeWorktreeWithRecovery` → fs-rm-retry exhaustion, see
 * `../worktree/lifecycle/pending-cleanup.js`). Entries whose Stage 1 retry now
 * succeeds are removed from the manifest; entries reaching
 * MAX_SWEEP_ATTEMPTS emit an `OPERATOR ACTION REQUIRED: persistent-lock`.
 *
 * Returns `{
 *   reaped, skipped,
 *   drainedPending, persistentPending, stillPending
 * }`.
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
 * Scan registered worktrees and force-remove any whose parent Story is
 * done (closed or `agent::done`). Never touches worktrees whose Story is
 * still open — those are live or in-flight.
 *
 * Provider reads are fanned out at concurrency 8 via `concurrentMap`; the
 * subsequent `git worktree remove` calls stay sequential because they
 * mutate `.git/worktrees/`.
 *
 * @param {object} opts
 * @param {object} opts.provider    ITicketingProvider-compatible; only
 *                                  `getTicket(id)` is required.
 * @param {string} opts.repoRoot    Absolute path to the main checkout.
 * @param {object} [opts.git]       `{ gitSpawn }` injection for tests.
 * @param {object} [opts.logger]    `{ info, warn, error }`.
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

  // Stage 2 + Stage 3: drain pending-cleanup manifest before touching the
  // live worktree list. Retrying the Stage 1 sequence here picks up entries
  // whose Windows file locks have since released; entries still stuck get
  // their handle-holders enumerated and terminated (Windows only) so the
  // ledger self-heals across sprints instead of accumulating.
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

  // Phase 1 — fan out provider reads. Each mapper call captures its own
  // error so a single transient provider hiccup doesn't trip
  // concurrentMap's first-rejection-wins policy and abort the whole sweep;
  // we want the original per-entry skip/continue semantics preserved.
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

  // Phase 2 — sequential `git worktree remove`. These mutate
  // .git/worktrees/ and the per-worktree admin dir; serializing avoids
  // racing git's own locking on Windows where a half-removed entry can
  // leave a partial admin dir that the next remove then trips over.
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

  // Drop any lingering worktree registrations. Cheap; safe to run whether
  // or not we actually removed anything.
  git.gitSpawn(repoRoot, 'worktree', 'prune');

  return {
    reaped,
    skipped,
    drainedPending: drainResult.drained,
    persistentPending: drainResult.persistent,
    stillPending: drainResult.stillPending,
  };
}
