/**
 * post-merge-pipeline.js — sequencer for the post-merge phases of
 * `story-close`.
 *
 * After the Story branch is merged into the Epic branch, several best-effort
 * cleanup + reporting phases must run:
 *
 *   1. worktree-reap       — remove the per-Story worktree.
 *   2. branch-cleanup      — delete the Story branch (local + remote).
 *   3. ticket-closure      — transition child Tasks + Story to agent::done
 *                            and run cascade completion.
 *   4. notification        — fire the story-complete webhook.
 *   5. dashboard-refresh   — regenerate the dispatch manifest.
 *   6. temp-cleanup        — delete the per-Story manifest pair under
 *                            `temp/epic-<eid>/story-<sid>/manifest.{md,json}`
 *                            (Epic #1030 Story #1040). Falls back to the
 *                            legacy flat `temp/story-manifest-<id>.{md,json}`
 *                            layout when `epicId` is unknown — both paths
 *                            are tried so partial migrations don't leak
 *                            files in either layout.
 *
 * Each phase is wrapped by `runPhase` so a single failure does not abort
 * the rest of the close-out — the same best-effort contract that the
 * pre-extraction inline code provided. Phase return values are merged into
 * a `state` object whose shape `runStoryClose` consumes to build the final
 * structured result.
 *
 * Branch cleanup is delegated to `lib/git-branch-cleanup.js` so the
 * "delete this branch from local + remote, treat not-found as success"
 * idempotency rules live in one place.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { generateAndSaveManifest } from '../../dispatcher.js';
import { notify } from '../../notify.js';
import { storyArtifactPath } from '../config/temp-paths.js';
import { deleteBranchBoth } from '../git-branch-cleanup.js';
import { Logger } from '../Logger.js';
import { appendSignal } from '../observability/signals-writer.js';
import { batchTransitionTickets } from '../story-lifecycle.js';
import { WorktreeManager } from '../worktree-manager.js';
import { toDone } from './label-transitions.js';
import { runPhase } from './phase-runner.js';
import { cascadeCompletion, STATE_LABELS } from './ticketing.js';

const WINDOWS_LOCK_RE =
  /(permission denied|access is denied|directory not empty|resource busy|device or resource busy|sharing violation|EACCES|EBUSY|ENOTEMPTY)/i;

function isWindowsReapLockFailure(reason) {
  return typeof reason === 'string' && WINDOWS_LOCK_RE.test(reason);
}

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

function createWorktreeReapState(overrides = {}) {
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
        timestamp: new Date().toISOString(),
        epicId: Number(epicId),
        storyId: Number(storyId),
        category: 'reap-failure',
        source: { tool: 'story-close.js' },
        details: `Worktree reap failed: ${reason}`,
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

export async function worktreeReapPhase(ctx) {
  const {
    orchestration,
    storyId,
    epicId,
    epicBranch,
    repoRoot,
    progress,
    logger,
    worktreeManagerFactory,
    config,
  } = ctx;
  const wtConfig = orchestration?.worktreeIsolation;
  const log = reapPhaseLogger(progress);
  if (!wtConfig?.enabled) {
    const state = createWorktreeReapState({ status: 'skipped-disabled' });
    log('WORKTREE', '⏭️ Skipping worktree reap (worktree isolation disabled)');
    return state;
  }
  if (!(wtConfig.reapOnSuccess ?? true)) {
    const state = createWorktreeReapState({ status: 'skipped-config' });
    log('WORKTREE', '⏭️ Skipping worktree reap (reapOnSuccess=false)');
    return state;
  }

  const wm = worktreeManagerFactory
    ? worktreeManagerFactory({ repoRoot, config: wtConfig })
    : new WorktreeManager({ repoRoot, config: wtConfig });
  const reapResult = await wm.reap(storyId, { epicBranch });
  let state = createWorktreeReapState({
    status: reapResult.removed
      ? 'removed'
      : reapResult.method === 'deferred-to-sweep'
        ? 'deferred-to-sweep'
        : 'failed',
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
  if (reapResult.removed) {
    log('WORKTREE', `🗑️  Reaped worktree: ${reapResult.path}`);
  } else if (reapResult.reason) {
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

  const leftover = await wm.list();
  const stillRegistered = leftover.find((r) =>
    /[/\\]story-\d+$/.test(r.path)
      ? Number(r.path.match(/story-(\d+)$/)?.[1]) === Number(storyId)
      : false,
  );
  if (stillRegistered) {
    state = {
      ...state,
      status: 'still-registered',
      path: stillRegistered.path,
      reason: 'still-registered-after-reap',
    };
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
  }
  return state;
}

export async function branchCleanupPhase(ctx, state = {}) {
  const {
    storyBranch,
    repoRoot,
    progress,
    logger,
    branchCleanup = deleteBranchBoth,
  } = ctx;
  const log = reapPhaseLogger(progress);
  log('CLEANUP', `Deleting story branch: ${storyBranch}`);

  const result = branchCleanup(storyBranch, {
    cwd: repoRoot,
    noVerify: true,
  });

  if (!result.local.deleted) {
    const stderr = (result.local.stderr || '').trim();
    const reapStatus = state.worktreeReap?.status;
    logger.error(
      `  Local branch ${storyBranch} delete failed: ${stderr || 'unknown'}. ` +
        `Check for stale worktrees (git worktree list).` +
        (reapStatus ? ` worktreeReap=${reapStatus}.` : ''),
    );
  }
  if (result.remote.deleted) {
    if (result.remote.reason === 'not-found') {
      log('CLEANUP', `Remote branch ${storyBranch} not found — skipped`);
    } else {
      log('CLEANUP', `✅ Remote branch ${storyBranch} deleted`);
    }
  }

  return {
    localDeleted: result.local.deleted,
    remoteDeleted: result.remote.deleted,
    localReason: result.local.reason,
    remoteReason: result.remote.reason,
  };
}

export async function ticketClosurePhase(ctx) {
  const { provider, tasks, storyId, progress, logger } = ctx;
  const log = reapPhaseLogger(progress);

  // The `notify` function is intentionally NOT forwarded to per-ticket
  // transitions here. `notificationPhase` fires a single consolidated
  // story-complete message immediately after this phase; passing notify
  // through would emit redundant state-transition events (one from the
  // cascade-up triggered by the last child Task, one from the explicit
  // Story toDone below) that show up as duplicate Slack/webhook lines per
  // story close.
  log('TICKETS', `Transitioning ${tasks.length} Task(s) to agent::done...`);
  const batch = await batchTransitionTickets(
    provider,
    tasks,
    STATE_LABELS.DONE,
    { progress: log },
  );
  const closedTickets = [...batch.transitioned, ...batch.skipped];

  log('TICKETS', `Transitioning Story #${storyId} to agent::done...`);
  try {
    await toDone(provider, [storyId]);
    closedTickets.push(storyId);
    log('TICKETS', `  #${storyId} → agent::done ✅`);
  } catch (err) {
    logger.error(
      `[phase=tickets]   Story #${storyId} → FAILED: ${err.message}`,
    );
  }

  log('TICKETS', 'Running cascade completion...');
  let cascadedTo = [];
  let cascadeFailed = [];
  try {
    const cascade = (await cascadeCompletion(provider, storyId)) ?? {
      cascadedTo: [],
      failed: [],
    };
    cascadedTo = cascade.cascadedTo ?? [];
    cascadeFailed = cascade.failed ?? [];
    if (cascadedTo.length > 0) {
      log(
        'TICKETS',
        `  Cascaded to: ${cascadedTo.map((id) => `#${id}`).join(', ')}`,
      );
    }
    for (const { parentId, error } of cascadeFailed) {
      logger.error(
        `  Cascade partial-failure on parent #${parentId}: ${error}`,
      );
    }
  } catch (err) {
    logger.error(`  Cascade fully failed (non-fatal): ${err.message}`);
  }

  return { closedTickets, cascadedTo, cascadeFailed };
}

export async function notificationPhase(ctx, state) {
  const {
    epicId,
    storyId,
    story,
    epicBranch,
    orchestration,
    progress,
    provider,
    notifyFn = notify,
    logger = Logger,
  } = ctx;
  const closedTickets = state.ticketClosure?.closedTickets ?? [];
  const log = reapPhaseLogger(progress);
  log('NOTIFY', `Sending story-complete notification for Story #${storyId}...`);
  await notifyFn(
    epicId,
    {
      severity: 'medium',
      message: `✅ Story #${storyId} — *${story.title}* — has been completed and merged into \`${epicBranch}\`. ${closedTickets.length} ticket(s) closed.`,
      event: 'story-merged',
      level: 'story',
      epicId,
    },
    { orchestration },
  );
  // Fire a rolled-up `epic-progress` webhook so operators see the Epic's
  // overall stories-done count tick up at each story-close, without
  // subscribing to the per-story `story-merged` channel. Comment is
  // suppressed (skipComment: true) — the operator-facing GitHub
  // comment is owned by the wave-record path; this fire is webhook-only.
  // Failures are swallowed by design (warn-then-continue) so a flaky
  // webhook never blocks story-close.
  if (provider && epicId) {
    try {
      const subs = (await provider.getSubTickets?.(epicId)) ?? [];
      const stories = subs.filter(
        (t) => Array.isArray(t.labels) && t.labels.includes('type::story'),
      );
      const total = stories.length;
      const done = stories.filter((s) => s.state === 'closed').length;
      const pct = total === 0 ? 0 : Math.round((done / total) * 100);
      await notifyFn(
        epicId,
        {
          severity: 'medium',
          message: `Epic #${epicId} progress · ${done}/${total} stories done (${pct}%) · Story #${storyId} merged`,
          event: 'epic-progress',
          level: 'epic',
          epicId,
        },
        { orchestration, skipComment: true },
      );
    } catch (err) {
      logger?.warn?.(
        `[notificationPhase] rolled-up epic-progress dispatch failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }
  log('NOTIFY', '✅ Notification sent');
}

export async function dashboardRefreshPhase(ctx) {
  const {
    epicId,
    provider,
    skipDashboard,
    progress,
    generateManifestFn = generateAndSaveManifest,
  } = ctx;
  const log = reapPhaseLogger(progress);
  if (skipDashboard) {
    log(
      'DASHBOARD',
      '⏭️ Skipping dashboard refresh (--skip-dashboard flag set)',
    );
    return false;
  }
  log('DASHBOARD', 'Regenerating dispatch manifest...');
  await generateManifestFn(epicId, true, null, { provider });
  log('DASHBOARD', '✅ Dashboard manifest updated (temp/)');
  return true;
}

export async function tempCleanupPhase(ctx) {
  const { storyId, epicId, projectRoot, progress, unlinkFn, config } = ctx;
  const log = reapPhaseLogger(progress);
  const unlink = unlinkFn ?? (await import('node:fs/promises')).unlink;

  // Per-Epic layout (Epic #1030 Story #1040): `temp/epic-<eid>/story-<sid>/manifest.{md,json}`.
  // Legacy flat layout: `temp/story-manifest-<sid>.{md,json}`. The migration
  // tolerates both — try the per-Epic path first when `epicId` is known,
  // and always sweep the legacy path so a half-migrated cohort doesn't
  // leave residue.
  const targets = [];
  if (epicId) {
    const eid = Number(epicId);
    const sid = Number(storyId);
    targets.push(
      {
        path: storyArtifactPath(eid, sid, 'manifest.md', config),
        label: `temp/epic-${epicId}/story-${storyId}/manifest.md`,
      },
      {
        path: storyArtifactPath(eid, sid, 'manifest.json', config),
        label: `temp/epic-${epicId}/story-${storyId}/manifest.json`,
      },
    );
  }
  // Legacy flat layout is rooted at the framework's projectRoot — this is
  // a half-migrated-cohort sweep, not a configured-tempRoot target. Once
  // the legacy paths can no longer exist on any live install, this block
  // can be deleted entirely.
  const legacyBase = path.join(
    projectRoot,
    'temp',
    `story-manifest-${storyId}`,
  );
  targets.push(
    { path: `${legacyBase}.md`, label: `temp/story-manifest-${storyId}.md` },
    {
      path: `${legacyBase}.json`,
      label: `temp/story-manifest-${storyId}.json`,
    },
  );

  for (const target of targets) {
    try {
      await unlink(target.path);
      log('CLEANUP', `🗑️  Deleted ${target.label}`);
    } catch {
      // File may not exist — deletion is idempotent.
    }
  }
}

/**
 * perfSummaryPhase — shells out to `analyze-execution.js --story <sid>
 * --epic <eid> --phase-timings <path>` so the analyzer is the single
 * writer of the `<!-- structured:story-perf-summary -->` comment on the
 * Story ticket (Epic #1030 Story #1046). Replaces the legacy
 * `<!-- structured:phase-timings -->` post that lived inline in
 * `post-merge-close.js`.
 *
 * Best-effort: any failure (missing analyzer, non-zero exit, no path
 * supplied) logs a warning and resolves — the merge has already
 * succeeded and we would rather lose the perf summary than roll back
 * closure.
 *
 * @param {{
 *   storyId: number|string,
 *   epicId: number|string,
 *   phaseTimingsPath: string|null|undefined,
 *   projectRoot?: string,
 *   progress?: Function,
 *   logger?: object,
 *   spawnFn?: typeof execFileSync,
 * }} ctx
 * @returns {Promise<{ status: 'ok'|'skipped'|'failed', reason?: string }>}
 */
export async function perfSummaryPhase(ctx) {
  const {
    storyId,
    epicId,
    phaseTimingsPath,
    projectRoot,
    progress,
    logger,
    spawnFn = execFileSync,
  } = ctx;
  const log = reapPhaseLogger(progress);
  if (!phaseTimingsPath) {
    log('PERF', '⏭️ Skipping perf-summary (no phase-timings path provided)');
    return { status: 'skipped', reason: 'no-phase-timings-path' };
  }
  const root = projectRoot ?? process.cwd();
  const analyzerPath = path.join(
    root,
    '.agents',
    'scripts',
    'analyze-execution.js',
  );
  const args = [
    analyzerPath,
    '--story',
    String(storyId),
    '--epic',
    String(epicId),
    '--phase-timings',
    phaseTimingsPath,
  ];
  log(
    'PERF',
    `Running analyzer: analyze-execution.js --story ${storyId} --epic ${epicId}`,
  );
  try {
    spawnFn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log('PERF', '✅ story-perf-summary posted');
    return { status: 'ok' };
  } catch (err) {
    const reason = err?.message ?? String(err);
    logger?.warn?.(
      `[post-merge-pipeline] ⚠️ analyze-execution failed (non-fatal): ${reason}`,
    );
    return { status: 'failed', reason };
  }
}

export const DEFAULT_POST_MERGE_PHASES = Object.freeze([
  {
    name: 'worktree-reap',
    fn: worktreeReapPhase,
    stateKey: 'worktreeReap',
    fallback: createWorktreeReapState({
      status: 'failed',
      reason: 'phase-error',
    }),
  },
  { name: 'branch-cleanup', fn: branchCleanupPhase, stateKey: 'branchCleanup' },
  { name: 'ticket-closure', fn: ticketClosurePhase, stateKey: 'ticketClosure' },
  { name: 'notification', fn: notificationPhase },
  {
    name: 'dashboard-refresh',
    fn: dashboardRefreshPhase,
    stateKey: 'manifestUpdated',
  },
  { name: 'temp-cleanup', fn: tempCleanupPhase },
  { name: 'perf-summary', fn: perfSummaryPhase, stateKey: 'perfSummary' },
]);

/**
 * Sequence the post-merge phases of `story-close`. Every phase runs
 * under `runPhase` so a single failure logs `[phase=<name>] <err>` and the
 * pipeline keeps going. Each phase's return value is recorded under its
 * `stateKey` (when defined) on the returned state object.
 *
 * @param {object} ctx          Phase collaborators (provider, notify,
 *                              logger, progress, etc.).
 * @param {Array<{name: string, fn: Function, stateKey?: string, fallback?: any}>} [phases]
 *                              Phase descriptors. Defaults to `DEFAULT_POST_MERGE_PHASES`.
 * @returns {Promise<object>}   Aggregated state from each phase.
 */
export async function runPostMergePipeline(
  ctx,
  phases = DEFAULT_POST_MERGE_PHASES,
) {
  const logger = ctx.logger ?? Logger;
  const state = {
    worktreeReap: createWorktreeReapState(),
    branchCleanup: { localDeleted: false, remoteDeleted: false },
    ticketClosure: { closedTickets: [], cascadedTo: [], cascadeFailed: [] },
    manifestUpdated: false,
  };
  for (const phase of phases) {
    const value = await runPhase(phase.name, () => phase.fn(ctx, state), {
      logger,
      fallback: phase.fallback,
    });
    if (phase.stateKey && value !== undefined) state[phase.stateKey] = value;
  }
  return state;
}
