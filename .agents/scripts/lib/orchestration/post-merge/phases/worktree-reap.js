/**
 * phases/worktree-reap.js — post-merge worktree reap phase.
 *
 * After a Story branch is merged into the Epic branch, this phase removes
 * the per-Story worktree at `.worktrees/story-<id>/`. The reap is split
 * into three concerns:
 *
 *   1. `worktreeReapPhase` — the phase entry point. Honors the
 *      `worktreeIsolation.{enabled,reapOnSuccess}` config, delegates the
 *      actual remove to `WorktreeManager.reap`, then runs a re-prune
 *      retry loop to clear stale `.git/worktrees/<name>/` registry
 *      entries that Windows file-locks occasionally leave behind.
 *   2. `applyStillRegisteredState` — classifies a still-registered entry
 *      after retries as either `stale-registry-entry` (operationally
 *      complete; schedule pending-cleanup drain) or `still-registered`
 *      (genuine failure; OPERATOR ACTION REQUIRED).
 *   3. Friction-signal emission via `signals-writer` so retrospectives
 *      surface lock failures and stale-registry escalations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleepPromise } from 'node:timers/promises';
import { getStoryBranch } from '../../../git-utils.js';
import { appendSignal } from '../../../observability/signals-writer.js';
import { recordPendingCleanup } from '../../../worktree/lifecycle/pending-cleanup.js';
import { WorktreeManager } from '../../../worktree-manager.js';

const WINDOWS_LOCK_RE =
  /(permission denied|access is denied|directory not empty|resource busy|device or resource busy|sharing violation|EACCES|EBUSY|ENOTEMPTY)/i;

/**
 * Backoff delays (ms) between `git worktree prune` + re-list passes when a
 * worktree entry is still registered after a successful reap. On Windows the
 * registry-cleanup half of `git worktree remove` often loses a race with a
 * background file handle (Defender / Search indexer / the editor) — the
 * directory and branch are gone, but `.git/worktrees/<name>/` is locked
 * for a beat. Three retries (250ms, 1s, 4s) cover the common case without
 * adding noticeable latency to clean POSIX runs.
 */
const STALE_REGISTRY_REPRUNE_DELAYS_MS = [250, 1000, 4000];

function isWindowsReapLockFailure(reason) {
  return typeof reason === 'string' && WINDOWS_LOCK_RE.test(reason);
}

function findStillRegisteredEntry(entries, storyId) {
  if (!Array.isArray(entries)) return undefined;
  const want = Number(storyId);
  return entries.find((r) => {
    if (!r || typeof r.path !== 'string') return false;
    const match = r.path.match(/[/\\]story-(\d+)$/);
    return match ? Number(match[1]) === want : false;
  });
}

function resolveWorktreeRoot(repoRoot, delivery) {
  if (!repoRoot) return null;
  const configuredRoot = delivery?.worktreeIsolation?.root ?? '.worktrees';
  return path.join(repoRoot, configuredRoot);
}

async function retryPruneUntilCleared(
  wm,
  storyId,
  { sleep, delays = STALE_REGISTRY_REPRUNE_DELAYS_MS } = {},
) {
  const sleepFn = typeof sleep === 'function' ? sleep : sleepPromise;
  let attempts = 0;
  let lastEntry;
  for (const delay of delays) {
    await sleepFn(delay);
    attempts += 1;
    if (typeof wm.prune === 'function') {
      try {
        await wm.prune();
      } catch {
        // best-effort — prune failure is non-fatal; fall through to list check
      }
    }
    const refreshed = (await wm.list()) ?? [];
    lastEntry = findStillRegisteredEntry(refreshed, storyId);
    if (!lastEntry) return { cleared: true, attempts };
  }
  return { cleared: false, attempts, stillRegistered: lastEntry };
}

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export function createWorktreeReapState(overrides = {}) {
  return {
    status: 'not-run',
    path: null,
    reason: null,
    method: null,
    pendingCleanup: null,
    branchDeleted: null,
    remoteBranchDeleted: null,
    ...overrides,
  };
}

async function emitReapFailureFriction({
  storyId,
  epicId,
  reapResult,
  epicBranch,
  logger,
  config,
}) {
  if (!epicId || !storyId) return;
  const reason = String(reapResult?.reason ?? 'unknown');
  const wtPath = reapResult?.path ?? '(unknown path)';
  try {
    await appendSignal({
      epicId: Number(epicId),
      storyId: Number(storyId),
      signal: {
        kind: 'friction',
        ts: new Date().toISOString(),
        epicId: Number(epicId),
        storyId: Number(storyId),
        category: 'reap-failure',
        emitter: { tool: 'story-close.js' },
        details: { message: `Worktree reap failed: ${reason}` },
        epicBranch,
        worktreePath: wtPath,
        reason,
      },
      config,
    });
  } catch (err) {
    logger?.warn?.(
      `[post-merge-pipeline] friction signal append failed: ${err?.message ?? err}`,
    );
  }
}

function resolveSkipState(wtConfig, log) {
  if (!wtConfig?.enabled) {
    log('WORKTREE', '⏭️ Skipping worktree reap (worktree isolation disabled)');
    return createWorktreeReapState({ status: 'skipped-disabled' });
  }
  if (!(wtConfig.reapOnSuccess ?? true)) {
    log('WORKTREE', '⏭️ Skipping worktree reap (reapOnSuccess=false)');
    return createWorktreeReapState({ status: 'skipped-config' });
  }
  return null;
}

function resolveInitialReapStatus(reapResult) {
  if (reapResult.removed) return 'removed';
  if (reapResult.method === 'deferred-to-sweep') return 'deferred-to-sweep';
  return 'failed';
}

function initialReapState(reapResult) {
  return createWorktreeReapState({
    status: resolveInitialReapStatus(reapResult),
    path: reapResult.path ?? null,
    reason: reapResult.reason ?? null,
    method: reapResult.method ?? null,
    pendingCleanup: reapResult.pendingCleanup ?? null,
    branchDeleted:
      reapResult.branchDeleted !== undefined ? reapResult.branchDeleted : null,
    remoteBranchDeleted:
      reapResult.remoteBranchDeleted !== undefined
        ? reapResult.remoteBranchDeleted
        : null,
  });
}

async function logReapOutcome({
  reapResult,
  log,
  logger,
  storyId,
  epicId,
  epicBranch,
  config,
}) {
  if (reapResult.removed) {
    log('WORKTREE', `🗑️  Reaped worktree: ${reapResult.path}`);
    return;
  }
  if (!reapResult.reason) return;
  await emitReapFailureFriction({
    storyId,
    epicId,
    reapResult,
    epicBranch,
    logger,
    config,
  });
  log(
    'WORKTREE',
    `⚠️  Worktree not reaped (${reapResult.reason}): ${reapResult.path}`,
  );
  if (isWindowsReapLockFailure(reapResult.reason)) {
    logger.error(
      `[story-close] OPERATOR ACTION REQUIRED: Worktree at ${reapResult.path} ` +
        `could not be removed (Windows lock/permission error: ${reapResult.reason}). ` +
        'Close any editor/terminal holding the path, then run ' +
        '`git worktree remove <path> --force && git worktree prune` to clean up.',
    );
  }
}

async function detectStillRegistered({ wm, storyId, log, sleep }) {
  const leftover = (await wm.list()) ?? [];
  const initial = findStillRegisteredEntry(leftover, storyId);
  if (!initial) return null;
  const retry = await retryPruneUntilCleared(wm, storyId, { sleep });
  if (retry.cleared) {
    log(
      'WORKTREE',
      `🧹 Stale worktree registry entry cleared after ${retry.attempts} re-prune attempt(s)`,
    );
    return null;
  }
  return retry.stillRegistered ?? initial;
}

async function escalateStillRegistered({
  state,
  stillRegistered,
  storyId,
  epicId,
  epicBranch,
  logger,
  config,
}) {
  logger.error(
    `[story-close] OPERATOR ACTION REQUIRED: Worktree still registered after reap: ` +
      `${stillRegistered.path}. Run ` +
      '`git worktree remove <path> --force && git worktree prune` to clean up.',
  );
  await emitReapFailureFriction({
    storyId,
    epicId,
    reapResult: {
      path: stillRegistered.path,
      reason: 'still-registered-after-reap',
    },
    epicBranch,
    logger,
    config,
  });
  return state;
}

function logStaleRegistryEntry({ state, stillRegistered, logger }) {
  logger.warn(
    `[story-close] Worktree directory removed and branch deleted, but ` +
      `\`git worktree list\` still shows ${stillRegistered.path}. ` +
      'Scheduled for background prune via pending-cleanup; ' +
      `branchDeleted=${state.branchDeleted}.`,
  );
  return state;
}

export async function worktreeReapPhase(ctx) {
  const {
    delivery,
    storyId,
    epicId,
    epicBranch,
    repoRoot,
    progress,
    logger,
    worktreeManagerFactory,
    config,
    sleep,
    recordPendingCleanupFn = recordPendingCleanup,
    pathExistsFn = fs.existsSync,
  } = ctx;
  const wtConfig = delivery?.worktreeIsolation;
  const log = reapPhaseLogger(progress);
  const skipState = resolveSkipState(wtConfig, log);
  if (skipState) return skipState;

  const wm = worktreeManagerFactory
    ? worktreeManagerFactory({ repoRoot, config: wtConfig })
    : new WorktreeManager({ repoRoot, config: wtConfig });
  const reapResult = await wm.reap(storyId, { epicBranch });
  let state = initialReapState(reapResult);
  await logReapOutcome({
    reapResult,
    log,
    logger,
    storyId,
    epicId,
    epicBranch,
    config,
  });

  const stillRegistered = await detectStillRegistered({
    wm,
    storyId,
    log,
    sleep,
  });
  if (!stillRegistered) return state;

  state = applyStillRegisteredState({
    state,
    stillRegistered,
    reapResult,
    storyId,
    delivery,
    repoRoot,
    logger,
    recordPendingCleanupFn,
    pathExistsFn,
  });
  if (state.status === 'still-registered') {
    return escalateStillRegistered({
      state,
      stillRegistered,
      storyId,
      epicId,
      epicBranch,
      logger,
      config,
    });
  }
  if (state.status === 'stale-registry-entry') {
    return logStaleRegistryEntry({ state, stillRegistered, logger });
  }
  return state;
}

/**
 * Decide how to treat a worktree entry that is still registered after reap +
 * re-prune retries. Two outcomes:
 *
 *   - `stale-registry-entry` (operationally complete): the reap succeeded,
 *     the worktree directory is gone, and the local branch was deleted by
 *     reap. The only artifact left is the `.git/worktrees/<name>/` registry
 *     entry — a Windows file-lock artifact, not a genuine cleanup failure.
 *     Record a pending-cleanup entry so the post-close drain (or the next
 *     plan-time sweep) re-runs `git worktree prune`, and let the close
 *     pipeline report `branchDeleted: true` honestly.
 *   - `still-registered` (genuine failure): the directory is still on disk
 *     OR the branch was not deleted. The pre-existing OPERATOR ACTION
 *     escalation still fires.
 */
function applyStillRegisteredState({
  state,
  stillRegistered,
  reapResult,
  storyId,
  delivery,
  repoRoot,
  logger,
  recordPendingCleanupFn,
  pathExistsFn,
}) {
  const pathGone = !pathExistsFn(stillRegistered.path);
  const branchDeleted = reapResult.branchDeleted === true;
  const operationallyComplete =
    reapResult.removed === true && pathGone && branchDeleted;
  if (!operationallyComplete) {
    return {
      ...state,
      status: 'still-registered',
      path: stillRegistered.path,
      reason: 'still-registered-after-reap',
    };
  }
  const worktreeRoot = resolveWorktreeRoot(repoRoot, delivery);
  let manifestEntry = null;
  if (worktreeRoot) {
    try {
      manifestEntry = recordPendingCleanupFn(worktreeRoot, {
        storyId: Number(storyId),
        branch: getStoryBranch(null, storyId),
        path: stillRegistered.path,
        push: false,
      });
    } catch (err) {
      logger?.warn?.(
        `[post-merge-pipeline] pending-cleanup record failed (continuing): ${err?.message ?? err}`,
      );
    }
  }
  return {
    ...state,
    status: 'stale-registry-entry',
    path: stillRegistered.path,
    reason: 'stale-registry-entry',
    pendingCleanup: manifestEntry ?? state.pendingCleanup,
  };
}
