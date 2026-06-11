/**
 * phases/drain.js — pending-cleanup drain / worktree-sweep boot phase.
 *
 * Runs `sweepStaleStoryWorktrees` when a ticketing `provider` is available
 * (normal CLI boot): drains `.pending-cleanup.json` with Windows escalation,
 * then reaps registered worktrees for done/closed stories. When `provider` is
 * omitted (unit tests), runs `forceDrainPendingCleanup` on the manifest only.
 */

import path from 'node:path';
import * as gitUtils from '../../../git-utils.js';
import { PROJECT_ROOT } from '../../../project-root.js';
import { forceDrainPendingCleanup } from '../../../worktree/lifecycle/force-drain.js';
import { readManifest } from '../../../worktree/lifecycle/pending-cleanup.js';
import { sweepStaleStoryWorktrees } from '../../plan-runner/worktree-sweep.js';

/**
 * Uses `delivery.worktreeIsolation.root` when present; defaults to
 * `.worktrees`.
 *
 * Non-blocking: stuck entries stay in the manifest; plan execution continues.
 *
 * Exposed for integration tests.
 *
 * @param {{ repoRoot?: string, config?: object, provider?: object, git?: object, logger?: object, fsRm?: function }} [opts]
 * @returns {Promise<object>} Canonical sweep/drain summary keyed on
 *   `drainedPending` / `persistentPending` / `stillPending`.
 */
export async function drainPendingCleanupAtBoot(opts = {}) {
  const repoRoot = opts.repoRoot ?? PROJECT_ROOT;
  const config = opts.config;
  const worktreeRoot = path.join(
    repoRoot,
    config?.delivery?.worktreeIsolation?.root ?? '.worktrees',
  );
  const git = opts.git ?? gitUtils;
  const logger = opts.logger ?? console;
  const fsRm = opts.fsRm;
  const provider = opts.provider;

  if (provider?.getTicket) {
    const sweep = await sweepStaleStoryWorktrees({
      provider,
      repoRoot,
      git,
      logger,
      worktreeRoot,
      fsRm,
    });
    const remaining =
      (sweep.persistentPending?.length ?? 0) +
      (sweep.stillPending?.length ?? 0);
    logger.info?.(
      `[epic-plan-spec] worktree sweep: reaped=${sweep.reaped.length} drainedPending=${sweep.drainedPending?.length ?? 0} remaining=${remaining}`,
    );
    return sweep;
  }

  const before = readManifest(worktreeRoot).length;
  if (before === 0) {
    return {
      reaped: [],
      skipped: [],
      drainedPending: [],
      persistentPending: [],
      stillPending: [],
    };
  }
  const result = await forceDrainPendingCleanup({
    repoRoot,
    worktreeRoot,
    git,
    fsRm,
    logger,
  });
  const remaining =
    (result.persistent?.length ?? 0) + (result.stillPending?.length ?? 0);
  logger.info?.(
    `[epic-plan-spec] pending-cleanup drain: reaped=${result.drained?.length ?? 0} remaining=${remaining}`,
  );
  return {
    reaped: [],
    skipped: [],
    drainedPending: result.drained,
    persistentPending: result.persistent,
    stillPending: result.stillPending,
    escalated: result.escalated,
    killedPids: result.killedPids,
    noHolders: result.noHolders,
    drainedDetails: result.drainedDetails,
    persistentDetails: result.persistentDetails,
    stillPendingDetails: result.stillPendingDetails,
  };
}
