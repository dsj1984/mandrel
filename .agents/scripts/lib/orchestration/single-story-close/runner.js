import nodeFs from 'node:fs';
import path from 'node:path';
import { buildDefaultGates } from '../../close-validation/gates.js';
import { runCloseValidation } from '../../close-validation/runner.js';
import { getCiDelivery } from '../../config/ci.js';
import { resolveConfig } from '../../config-resolver.js';
import { getStoryBranch, gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import { createProvider } from '../../provider-factory.js';
import { flipLabelAndNotify } from '../../single-story/story-merged-notify.js';
import { WorktreeManager } from '../../worktree-manager.js';
import { runCodeReview as runCodeReviewDefault } from '../code-review.js';
import { releaseStoryLease } from '../single-story-lease-guard.js';
import { runAutoMergePhase } from './phases/auto-merge.js';
import { runBaseSyncPhase } from './phases/base-sync.js';
import { runCloseValidationPhase } from './phases/close-validation.js';
import { parsePrNumber, runStoryScopeReview } from './phases/code-review.js';
import { runConfirmMergePhase } from './phases/confirm-merge.js';
import { parseCloseOptions } from './phases/options.js';
import { ensurePullRequestWith } from './phases/pull-request.js';
import { pushStoryBranch } from './phases/push.js';
import { reapWorktreePhase } from './phases/worktree-reap.js';
import { runWrongTreeGuardPhase } from './phases/wrong-tree-guard.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

function alreadyClosedResult(storyId) {
  return {
    success: true,
    result: {
      storyId,
      standalone: true,
      action: 'noop',
      reason: 'already-closed',
    },
  };
}

function resolveWorktreePath({ cwd, config, storyId }) {
  const root = config.delivery?.worktreeIsolation?.root ?? '.worktrees';
  const candidate = path.resolve(cwd, root, `story-${storyId}`);
  return nodeFs.existsSync(candidate) ? candidate : null;
}

async function runPrePushPhases({
  cwd,
  worktreePath,
  config,
  baseBranch,
  storyBranch,
  storyId,
  provider,
  skipValidation,
  skipSync,
  injectedSync,
  injectedGitSpawn,
}) {
  await runWrongTreeGuardPhase({
    cwd,
    worktreePath,
    baseBranch,
    storyId,
    provider,
    progress,
    gitSpawn: injectedGitSpawn,
  });
  if (!skipValidation) {
    await runCloseValidationPhase({
      cwd,
      worktreePath,
      config,
      baseBranch,
      storyBranch,
      storyId,
      progress,
      runCloseValidation,
      buildDefaultGates,
    });
  } else {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
  }
  if (!skipSync) {
    await runBaseSyncPhase({
      cwd,
      worktreePath,
      baseBranch,
      storyBranch,
      storyId,
      provider,
      injectedSync,
      progress,
    });
  } else {
    progress('SYNC', '⏭ Skipped (--skip-sync).');
  }
}

async function openAndReviewPr({
  cwd,
  story,
  storyId,
  storyBranch,
  baseBranch,
  provider,
  injectedGh,
  injectedRunCodeReview,
}) {
  pushStoryBranch({ cwd, storyBranch, gitSync, progress });
  const prUrl = await ensurePullRequestWith({
    cwd,
    storyId,
    storyTitle: story.title,
    storyBranch,
    baseBranch,
    gh: injectedGh,
    progress,
  });
  const prNumber = parsePrNumber(prUrl);
  const reviewOutcome = await runStoryScopeReview({
    cwd,
    storyId,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    provider,
    runCodeReviewFn: injectedRunCodeReview ?? runCodeReviewDefault,
    progress,
  });
  if (reviewOutcome.halted) {
    throw new Error(
      `[single-story-close] Story-scope review reported ${reviewOutcome.severity?.critical ?? 0} critical blocker(s) on PR ${prUrl}. ` +
        'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/single-story-deliver`.',
    );
  }
  return { prUrl, prNumber };
}

async function releaseLease({
  provider,
  storyId,
  config,
  injectedReleaseLease,
}) {
  try {
    const release = injectedReleaseLease ?? releaseStoryLease;
    const outcome = await release({ provider, storyId, config });
    progress(
      'LEASE',
      outcome.released
        ? `🔓 Story #${storyId} lease released.`
        : `🔓 Story #${storyId} lease not released (${outcome.reason}).`,
    );
    return outcome.released;
  } catch (err) {
    progress(
      'LEASE',
      `⚠️ lease release failed (close continues): ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Story #4257 — run a blocked-prone phase and, if it throws, release the
 * assignee-lease best-effort BEFORE re-throwing the original error.
 *
 * The two recoverable-blocked close exits (base-sync conflict in
 * `runBaseSyncPhase`, and a critical-blocker review halt in
 * `openAndReviewPr`) throw before the clean-close lease release at the
 * tail of `runSingleStoryClose`, stranding the operator's lease until its
 * TTL expires. That fail-closed-refuses a different operator who picks up
 * the blocked Story — exactly the hand-off case. Releasing here closes
 * that gap.
 *
 * The original throw is preserved verbatim (per
 * `rules/orchestration-error-handling.md` — throw, never `Logger.fatal`),
 * so the CLI boundary still maps it to a non-zero exit; the lease release
 * must not swallow it. `releaseLease` is itself best-effort and never
 * throws, so it cannot mask the real failure. Fail-closed re-acquire
 * semantics are preserved: `releaseStoryLease` no-ops when the operator no
 * longer holds the claim, and a self-held re-acquire on a re-run still
 * succeeds against the now-unclaimed ticket.
 *
 * @template T
 * @param {() => Promise<T>} run The blocked-prone phase to execute.
 * @param {{ provider: object, storyId: number, config: object, injectedReleaseLease?: Function }} leaseArgs
 * @returns {Promise<T>}
 */
async function releaseLeaseOnBlock(run, leaseArgs) {
  try {
    return await run();
  } catch (err) {
    await releaseLease(leaseArgs);
    throw err;
  }
}

function closeResult({
  storyId,
  storyBranch,
  baseBranch,
  prUrl,
  prNumber,
  autoMergeEnabled,
  autoMergeReason,
  worktreeReaped,
  leaseReleased,
  waitedForMerge = false,
  merged = false,
}) {
  return {
    storyId,
    standalone: true,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    pushed: true,
    autoMergeEnabled,
    autoMergeReason,
    worktreeReaped,
    leaseReleased,
    waitedForMerge,
    merged,
    note: waitedForMerge
      ? 'Headless must-land: PR merge confirmed. Story flipped agent::closing → agent::done and the issue closed (confirmStoryMerged).'
      : autoMergeEnabled
        ? 'PR open against baseBranch with auto-merge enabled. Story rests at agent::closing (issue stays OPEN). GitHub will squash-merge when required checks pass; run single-story-confirm-merge.js after the merge confirms to flip agent::done and close the issue (the Closes #<id> footer also auto-closes it).'
        : 'PR open against baseBranch. Story rests at agent::closing (issue stays OPEN). Operator merges via GitHub UI; run single-story-confirm-merge.js after the merge confirms to flip agent::done (the Closes #<id> footer also auto-closes the issue).',
  };
}

export async function runSingleStoryClose({
  storyId: storyIdParam,
  cwd: cwdParam,
  skipValidation: skipValidationParam,
  skipSync: skipSyncParam,
  noAutoMerge: noAutoMergeParam,
  noFullScopeCrap: noFullScopeCrapParam,
  waitForMerge: waitForMergeParam,
  noWaitForMerge: noWaitForMergeParam,
  injectedProvider,
  injectedConfig,
  injectedNotify,
  injectedSync,
  injectedRunCodeReview,
  injectedGh,
  injectedGitSpawn,
  injectedReleaseLease,
} = {}) {
  const options = parseCloseOptions({
    storyIdParam,
    cwdParam,
    skipValidationParam,
    skipSyncParam,
    noAutoMergeParam,
    noFullScopeCrapParam,
    waitForMergeParam,
    noWaitForMergeParam,
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--no-full-scope-crap] [--wait-merge|--no-wait-merge]',
    );
  }

  const config = injectedConfig || resolveConfig({ cwd: options.cwd });
  const provider = injectedProvider || createProvider(config);
  const baseBranch = config.project?.baseBranch ?? 'main';
  const storyBranch = getStoryBranch(0, options.storyId);

  progress('INIT', `Closing standalone Story #${options.storyId}...`);
  const story = await provider.getTicket(options.storyId);
  if (story.state === 'closed') {
    progress(
      'NOOP',
      `Story #${options.storyId} is already closed. Nothing to do.`,
    );
    return alreadyClosedResult(options.storyId);
  }

  const worktreePath = resolveWorktreePath({
    cwd: options.cwd,
    config,
    storyId: options.storyId,
  });
  // Story #4257 — the base-sync conflict and review-critical exits throw
  // before the clean-close lease release at the tail of this function.
  // Wrap both blocked-prone phases so the lease is released best-effort
  // before the throw propagates; the original error is preserved.
  const leaseArgs = {
    provider,
    storyId: options.storyId,
    config,
    injectedReleaseLease,
  };
  await releaseLeaseOnBlock(
    () =>
      runPrePushPhases({
        ...options,
        config,
        baseBranch,
        storyBranch,
        provider,
        worktreePath,
        injectedSync,
        injectedGitSpawn,
      }),
    leaseArgs,
  );

  const { prUrl, prNumber } = await releaseLeaseOnBlock(
    () =>
      openAndReviewPr({
        cwd: options.cwd,
        story,
        storyId: options.storyId,
        storyBranch,
        baseBranch,
        provider,
        injectedGh,
        injectedRunCodeReview,
      }),
    leaseArgs,
  );
  const { autoMergeEnabled, autoMergeReason } = await runAutoMergePhase({
    cwd: options.cwd,
    prNumber,
    prUrl,
    noAutoMerge: options.noAutoMerge,
    autoMergePolicy: getCiDelivery(config).autoMerge,
    gh: injectedGh,
    progress,
  });
  await flipLabelAndNotify({
    provider,
    notifyFn: injectedNotify,
    storyId: options.storyId,
    story,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    config,
    progress,
  });
  const worktreeReaped = await reapWorktreePhase({
    cwd: options.cwd,
    storyId: options.storyId,
    worktreePath,
    wtIsolation: config.delivery?.worktreeIsolation,
    progress,
    WorktreeManager,
  });
  const leaseReleased = await releaseLease(leaseArgs);

  // Story #4428 — headless must-land: `--wait-merge` polls the just-armed
  // PR to merge confirmation (or an explicit `agent::blocked` +
  // `merge.unlanded`) instead of resting at `agent::closing`. Attended
  // (non-headless) runs never set this flag, so the exit shape below is
  // unreachable and the pre-existing early-return is byte-identical.
  if (options.waitForMerge) {
    const waitOutcome = await runConfirmMergePhase({
      cwd: options.cwd,
      storyId: options.storyId,
      prNumber,
      prUrl,
      autoMergeEnabled,
      autoMergeReason,
      provider,
      config,
      progress,
      injectedGh,
      injectedNotify,
    });
    if (!waitOutcome.confirmed) {
      throw new Error(
        `[single-story-close] Headless must-land: PR ${prUrl} did not reach a confirmed merge ` +
          `(blockClass=${waitOutcome.blockClass}). Story #${options.storyId} was transitioned to ` +
          `agent::blocked with a merge.unlanded lifecycle event. Reason: ${waitOutcome.reason}`,
      );
    }
    const result = closeResult({
      storyId: options.storyId,
      storyBranch,
      baseBranch,
      prUrl,
      prNumber,
      autoMergeEnabled,
      autoMergeReason,
      worktreeReaped,
      leaseReleased,
      waitedForMerge: true,
      merged: true,
    });
    Logger.info(
      `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
    );
    progress(
      'DONE',
      `✅ Standalone Story #${options.storyId}: PR merged → ${prUrl}`,
    );
    return { success: true, result };
  }

  const result = closeResult({
    storyId: options.storyId,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    autoMergeEnabled,
    autoMergeReason,
    worktreeReaped,
    leaseReleased,
  });

  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress(
    'DONE',
    `✅ Standalone Story #${options.storyId}: PR ready → ${prUrl}`,
  );
  return { success: true, result };
}
