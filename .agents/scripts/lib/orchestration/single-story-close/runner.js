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
import {
  buildTerminalEnvelope,
  NEXT_COMMANDS,
} from '../story-deliver-terminal.js';
import { runAutoMergePhase } from './phases/auto-merge.js';
import { runBaseSyncPhase } from './phases/base-sync.js';
import { runCloseValidationPhase } from './phases/close-validation.js';
import { parsePrNumber, runStoryScopeReview } from './phases/code-review.js';
import { runConfirmMergePhase } from './phases/confirm-merge.js';
import { parseCloseOptions, resolveWaitForMerge } from './phases/options.js';
import { ensurePullRequestWith } from './phases/pull-request.js';
import { pushStoryBranch } from './phases/push.js';
import { handleCriticalReviewBlock } from './phases/review-block.js';
import { reapWorktreePhase } from './phases/worktree-reap.js';
import { runWrongTreeGuardPhase } from './phases/wrong-tree-guard.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Emit the terminal envelope on stdout alongside the legacy close result.
 *
 * Both are printed: the envelope is the contract callers parse (Story
 * #4543), while `STORY CLOSE RESULT` stays byte-compatible for the existing
 * surfaces that grep it. One writer, one place — so the envelope can never
 * be emitted from a path that forgot it.
 */
function emitTerminal({ terminal, result }) {
  if (result) {
    Logger.info(
      `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
    );
  }
  Logger.info(
    `\n--- STORY DELIVER TERMINAL ---\n${JSON.stringify(terminal, null, 2)}\n--- END TERMINAL ---\n`,
  );
}

function alreadyClosedResult(storyId) {
  const result = {
    storyId,
    standalone: true,
    action: 'noop',
    reason: 'already-closed',
  };
  // Idempotent re-run against a finished Story. `landed` is the honest
  // status — the issue is closed, so the work is on the base branch — and
  // there is nothing left to command.
  const terminal = buildTerminalEnvelope({
    storyId,
    status: 'landed',
    phase: 'done',
    nextCommand: null,
    elapsedSeconds: 0,
  });
  emitTerminal({ terminal, result });
  return { success: true, result, terminal };
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
    const criticalCount = reviewOutcome.severity?.critical ?? 0;
    await handleCriticalReviewBlock({
      provider,
      storyId,
      prUrl,
      criticalCount,
    });
    throw new Error(
      `[single-story-close] Story-scope review reported ${criticalCount} critical blocker(s) on PR ${prUrl}. ` +
        'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/deliver`.',
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
 * tail of `runSingleStoryClose`, stranding the operator's lease
 * indefinitely. The standalone lease does **not** expire by TTL: it is
 * fail-closed by design (`lease-guard-shared.js` anchors `heartbeatAt` to
 * now, so `isClaimLive` is true for any foreign assignee regardless of the
 * configured TTL), so a stranded claim is cleared only by `--steal` or
 * de-assignment. That fail-closed-refuses a different operator who picks up
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
      ? 'Close-and-land: PR merge confirmed. Story flipped agent::closing → agent::done, the issue closed (confirmStoryMerged), and the post-land tail ran.'
      : autoMergeEnabled
        ? 'PR open against baseBranch with auto-merge enabled. Story rests at agent::closing (issue stays OPEN). GitHub will squash-merge when required checks pass; run single-story-confirm-merge.js after the merge confirms to flip agent::done and close the issue (the Closes #<id> footer also auto-closes it).'
        : 'PR open against baseBranch. Story rests at agent::closing (issue stays OPEN). Operator merges via GitHub UI; run single-story-confirm-merge.js after the merge confirms to flip agent::done (the Closes #<id> footer also auto-closes the issue).',
  };
}

/**
 * Map a `runConfirmMergePhase` outcome onto the schema-validated terminal
 * envelope (Story #4543). One writer, one shape — the two prose contracts
 * this replaces disagreed with each other precisely because each surface
 * assembled its own.
 *
 * @returns {object} A validated `story-deliver-terminal` envelope.
 */
function terminalFromWaitOutcome({
  waitOutcome,
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  prUrl,
  autoMergeEnabled,
  gates,
  elapsedSeconds,
}) {
  const prBase = {
    number: prNumber,
    url: prUrl ?? null,
    autoMergeEnabled: Boolean(autoMergeEnabled),
  };
  const common = {
    storyId,
    storyBranch,
    baseBranch,
    gates,
    elapsedSeconds,
  };

  if (waitOutcome.terminal === 'landed') {
    return buildTerminalEnvelope({
      ...common,
      status: 'landed',
      phase: 'post-land',
      pr: { ...prBase, state: 'MERGED', checksStatus: 'success' },
      tail: waitOutcome.tail,
      nextCommand: null,
    });
  }

  if (waitOutcome.terminal === 'pending') {
    return buildTerminalEnvelope({
      ...common,
      status: 'pending',
      phase: 'confirm-merge',
      pr: {
        ...prBase,
        state: waitOutcome.prProbe?.state ?? 'OPEN',
        checksStatus: waitOutcome.prProbe?.checksStatus ?? null,
      },
      waitBudget: waitOutcome.waitBudget,
      nextCommand: NEXT_COMMANDS.resumeLand(storyId),
    });
  }

  // blocked — the classifier already named the class and the friction
  // comment already carries the class-specific remediation, so the next
  // command mirrors it rather than inventing a second opinion.
  const nextCommand =
    waitOutcome.blockClass === 'checks-failed'
      ? NEXT_COMMANDS.watchCi(storyId, prNumber)
      : waitOutcome.blockClass === 'merged-flip-failed'
        ? NEXT_COMMANDS.confirmMerge(storyId)
        : NEXT_COMMANDS.recover(storyId);
  return buildTerminalEnvelope({
    ...common,
    status: 'blocked',
    phase: 'confirm-merge',
    pr: {
      ...prBase,
      state: waitOutcome.prProbe?.state ?? null,
      checksStatus: waitOutcome.prProbe?.checksStatus ?? null,
    },
    blocked: {
      blockClass: waitOutcome.blockClass,
      reason: waitOutcome.reason,
      frictionCommentId: waitOutcome.frictionCommentId ?? null,
    },
    nextCommand,
  });
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
  maxWaitSeconds: maxWaitSecondsParam,
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
    maxWaitSecondsParam,
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--no-full-scope-crap] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>]',
    );
  }

  const startedAtMs = Date.now();
  const config = injectedConfig || resolveConfig({ cwd: options.cwd });
  const provider = injectedProvider || createProvider(config);
  const baseBranch = config.project?.baseBranch ?? 'main';
  const storyBranch = getStoryBranch(options.storyId);

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

  // Close-and-land (Story #4428; default since `delivery.routing.closeAndLand`
  // — Story #4539): poll the just-armed PR to merge confirmation, or block
  // explicitly with `merge.unlanded`, instead of resting at `agent::closing`.
  // This is the DEFAULT path for attended and headless runs alike.
  //
  // Resolved here rather than at parse time because two inputs do not exist
  // until now: the resolved config (whose cwd the parse produces) and the
  // actual arm outcome. A PR the operator deliberately left un-armed
  // (`--no-auto-merge` / `autoMerge: "strict"`) has nothing to land, so it
  // rests at `agent::closing` for the human instead of burning the poll
  // budget and then blocking a healthy Story.
  const { waitForMerge, reason: waitForMergeReason } = resolveWaitForMerge({
    waitForMergeExplicit: options.waitForMergeExplicit,
    noWaitForMerge: options.noWaitForMerge,
    config,
    autoMergeReason,
  });
  if (waitForMergeReason === 'operator-merge') {
    progress(
      'MERGE',
      `⏭  Not waiting for merge (${autoMergeReason}) — the operator owns this merge; ` +
        `Story #${options.storyId} rests at agent::closing.` +
        (options.waitForMergeExplicit === true
          ? ' --wait-merge cannot land a PR that was deliberately left un-armed.'
          : ''),
    );
  }
  const gates = {
    validation: options.skipValidation ? 'skipped' : 'passed',
    baseSync: options.skipSync ? 'skipped' : 'passed',
    codeReview: 'passed',
  };

  if (waitForMerge) {
    const waitOutcome = await runConfirmMergePhase({
      cwd: options.cwd,
      storyId: options.storyId,
      storyBranch,
      baseBranch,
      prNumber,
      prUrl,
      autoMergeEnabled,
      autoMergeReason,
      provider,
      config,
      maxWaitSeconds: options.maxWaitSeconds,
      progress,
      injectedGh,
      injectedNotify,
    });
    const terminal = terminalFromWaitOutcome({
      waitOutcome,
      storyId: options.storyId,
      storyBranch,
      baseBranch,
      prNumber,
      prUrl,
      autoMergeEnabled,
      gates,
      elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    });
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
      merged: waitOutcome.confirmed === true,
    });
    emitTerminal({ terminal, result });

    if (terminal.status === 'landed') {
      progress('DONE', `✅ Story #${options.storyId}: PR merged → ${prUrl}`);
    } else if (terminal.status === 'pending') {
      // NOT a failure and NOT a block — the wait reached the edge of its
      // host slot with the PR healthy and in flight. The CLI maps this to
      // its own exit code so a caller can resume without classifying.
      progress(
        'PENDING',
        `⏸  Story #${options.storyId}: PR ${prUrl} still in flight — resume with: ${terminal.nextCommand}`,
      );
    } else {
      progress(
        'BLOCKED',
        `🛑 Story #${options.storyId}: PR ${prUrl} did not land ` +
          `(blockClass=${terminal.blocked?.blockClass}). Story is at agent::blocked. ` +
          `Next: ${terminal.nextCommand}`,
      );
    }
    return { success: terminal.status === 'landed', result, terminal };
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
  // `--no-wait-merge` / operator-merge: the PR is open and the human owns
  // the land. That is a `pending` terminal by definition — the work is not
  // done, nothing is broken, and one named command finishes it — rather
  // than a fourth status invented for this one case.
  const terminal = buildTerminalEnvelope({
    storyId: options.storyId,
    status: 'pending',
    phase: 'auto-merge',
    storyBranch,
    baseBranch,
    pr: {
      number: prNumber,
      url: prUrl ?? null,
      state: 'OPEN',
      autoMergeEnabled: Boolean(autoMergeEnabled),
    },
    gates,
    nextCommand: NEXT_COMMANDS.confirmMerge(options.storyId),
    elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
  });
  emitTerminal({ terminal, result });
  progress(
    'DONE',
    `✅ Story #${options.storyId}: PR ready → ${prUrl} (${waitForMergeReason})`,
  );
  return { success: true, result, terminal };
}
