/**
 * cleanup-reconciler.js — post-merge worktree-cleanup drain + reconciliation.
 *
 * Extracted from story-close.js (Story #955, Theme A part 2) so the close
 * orchestrator becomes a thin CLI shell. This module owns the three
 * worktree-cleanup helpers that previously lived inline in `runStoryClose`:
 *
 *   - drainPendingCleanupAfterClose — drives the `forceDrainPendingCleanup`
 *     pass that runs after the post-merge pipeline reaps the per-story
 *     worktree. Logs the drain summary via the supplied progress sink.
 *   - reconcileCleanupState         — pure helper that folds the drain
 *     outcome back into the pipeline's `worktreeReap` + `branchCleanup`
 *     state, lifting `localDeleted` / `remoteDeleted` flags and the
 *     `closeDrainStatus` enum.
 *   - getCloseDrainStatus           — names the three deferred-to-sweep
 *     outcomes (persistent / still-pending / not-found) so callers don't
 *     have to read a nested ternary.
 *
 * No close-time control flow lives here — the helpers are pure functions
 * (or thin wrappers around an injected `drainFn`) and exercise nothing
 * outside the worktree-isolation surface.
 */

import path from 'node:path';
import { gitSpawn } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import { forceDrainPendingCleanup } from '../../worktree/lifecycle/force-drain.js';

function resolveWorktreeRoot(repoRoot, delivery) {
  const configuredRoot = delivery?.worktreeIsolation?.root ?? '.worktrees';
  return path.join(repoRoot, configuredRoot);
}

export async function drainPendingCleanupAfterClose({
  repoRoot,
  delivery,
  progress: progressFn,
  logger = Logger,
  git = { gitSpawn },
  drainFn = forceDrainPendingCleanup,
} = {}) {
  const wtConfig = delivery?.worktreeIsolation;
  if (!wtConfig?.enabled) return null;
  const worktreeRoot = resolveWorktreeRoot(repoRoot, delivery);
  const result = await drainFn({
    repoRoot,
    worktreeRoot,
    git,
    logger,
  });
  const totalResolved =
    (result.drained?.length ?? 0) +
    (result.persistent?.length ?? 0) +
    (result.stillPending?.length ?? 0);
  if (totalResolved > 0 && typeof progressFn === 'function') {
    progressFn(
      'WORKTREE',
      `Pending cleanup drain: drained=${result.drained.length}, persistent=${result.persistent.length}, stillPending=${result.stillPending.length}`,
    );
  }
  return { worktreeRoot, ...result };
}

const REAP_STATUSES_DRAIN_FLIPS = new Set([
  'deferred-to-sweep',
  'stale-registry-entry',
]);

function applyDrainedEntry(nextWorktreeReap, nextBranchCleanup, drainedEntry) {
  if (drainedEntry.localBranchDeleted !== null) {
    nextBranchCleanup.localDeleted =
      nextBranchCleanup.localDeleted || !!drainedEntry.localBranchDeleted;
  }
  if (drainedEntry.remoteBranchDeleted !== null) {
    nextBranchCleanup.remoteDeleted =
      nextBranchCleanup.remoteDeleted || !!drainedEntry.remoteBranchDeleted;
  }
  if (REAP_STATUSES_DRAIN_FLIPS.has(nextWorktreeReap.status)) {
    nextWorktreeReap.status = 'removed-after-drain';
  }
  nextWorktreeReap.pendingCleanup = null;
  nextWorktreeReap.closeDrainStatus = 'drained';
}

export function reconcileCleanupState({
  storyId,
  worktreeReap,
  branchCleanup,
  pendingCleanupDrain,
}) {
  const normalizedStoryId = Number(storyId);
  const nextWorktreeReap = worktreeReap ? { ...worktreeReap } : null;
  const nextBranchCleanup = branchCleanup ? { ...branchCleanup } : null;
  if (!pendingCleanupDrain || !nextWorktreeReap || !nextBranchCleanup) {
    return { worktreeReap: nextWorktreeReap, branchCleanup: nextBranchCleanup };
  }

  const drainedEntry =
    pendingCleanupDrain.drainedDetails?.find(
      (entry) => Number(entry.storyId) === normalizedStoryId,
    ) ?? null;

  if (drainedEntry) {
    applyDrainedEntry(nextWorktreeReap, nextBranchCleanup, drainedEntry);
    return { worktreeReap: nextWorktreeReap, branchCleanup: nextBranchCleanup };
  }

  if (REAP_STATUSES_DRAIN_FLIPS.has(nextWorktreeReap.status)) {
    nextWorktreeReap.closeDrainStatus = getCloseDrainStatus({
      isPersistent:
        pendingCleanupDrain.persistent?.includes(normalizedStoryId) ?? false,
      isStillPending:
        pendingCleanupDrain.stillPending?.includes(normalizedStoryId) ?? false,
    });
  }

  return { worktreeReap: nextWorktreeReap, branchCleanup: nextBranchCleanup };
}

/**
 * Resolve the deferred-to-sweep close-drain status when the current Story's
 * pending-cleanup entry was *not* drained on this close. Three outcomes:
 *
 *   - `'persistent'`   — the entry has hit the persistent-lock threshold
 *                        (`MAX_SWEEP_ATTEMPTS` reached). `isPersistent` wins
 *                        regardless of whether the entry is also still in
 *                        the live pending list, because operator-action is
 *                        the authoritative outcome.
 *   - `'still-pending'`— the entry is in the pending list but has not yet
 *                        crossed the persistent threshold. The next sweep
 *                        run will retry.
 *   - `'not-found'`    — the entry is in neither list. Either the drain
 *                        cleared it before this reconcile saw it, or this
 *                        Story never had a pending entry. Treated as a
 *                        clean state for downstream callers.
 *
 * Extracted from a nested ternary so the truth table is greppable and each
 * branch carries an explicit name.
 *
 * @param {{ isPersistent: boolean, isStillPending: boolean }} flags
 * @returns {'persistent' | 'still-pending' | 'not-found'}
 */
export function getCloseDrainStatus({ isPersistent, isStillPending }) {
  if (isPersistent) return 'persistent';
  if (isStillPending) return 'still-pending';
  return 'not-found';
}
