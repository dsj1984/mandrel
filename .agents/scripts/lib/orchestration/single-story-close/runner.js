import nodeFs from 'node:fs';
import path from 'node:path';
import { buildDefaultGates } from '../../close-validation/gates.js';
import { runCloseValidation } from '../../close-validation/runner.js';
import { getCiDelivery } from '../../config/ci.js';
import { resolveConfig } from '../../config-resolver.js';
import { getStoryBranch, gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import { emitTerminalFriction } from '../../observability/runtime-friction.js';
import { emitTerseResult } from '../../observability/terse-result.js';
import { createProvider } from '../../provider-factory.js';
import { flipLabelAndNotify } from '../../single-story/story-merged-notify.js';
import { WorktreeManager } from '../../worktree-manager.js';
import { runCodeReview as runCodeReviewDefault } from '../code-review.js';
import { releaseStoryLease } from '../single-story-lease-guard.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  NEXT_COMMANDS,
  terminalFromWaitOutcome,
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
 *
 * Story #4578 — the same one-place property is why the runtime-derived
 * friction emit hangs here: a close that ends `failed`, or parks `pending`
 * on an exhausted merge-wait budget, is friction the retro must see, and
 * routing it through the single emitter means no terminal path can forget
 * it. `emitTerminalFriction` decides what (if anything) is worth a record —
 * see `frictionForTerminal` for why `blocked` and a `--no-wait-merge`
 * `pending` are deliberately NOT flagged here.
 *
 * Async, and awaited by every caller: the CLI exits via `process.exit` the
 * moment `main` resolves, so a fire-and-forget append would be discarded.
 * The emit is best-effort internally and cannot throw.
 */
async function emitTerminal({ terminal, result, config }) {
  // Story #4685 — the human-facing result dump goes to a temp log; the agent
  // acts on the (separate, unsuppressible) terminal envelope emitted below.
  // The single summary line keeps the fields worth an at-a-glance read.
  if (result) {
    emitTerseResult({
      label: 'STORY CLOSE RESULT',
      result,
      scope: result.storyId,
      summary: {
        storyId: result.storyId,
        action: result.action,
        reason: result.reason,
        prNumber: result.prNumber,
        status: terminal?.status,
      },
    });
  }
  emitTerminalEnvelope(terminal);
  await emitTerminalFriction({ envelope: terminal, config });
}

/**
 * Terminal for a Story that was already closed before this run started.
 *
 * `state: 'closed'` alone does NOT mean the work landed. GitHub closes an
 * issue as `completed` (the `Closes #<id>` footer firing on merge — the work
 * IS on the base branch) or as `not_planned` (superseded by a re-plan,
 * abandoned — nothing ever merged). Reporting the second as `landed` told
 * `/deliver` that work had reached `main` when no PR ever merged, which would
 * also satisfy any dependent Story waiting on it. Fail loudly instead: being
 * handed an abandoned Story is an input error only the operator can resolve.
 *
 * A null `stateReason` keeps the `completed` reading — GitHub defaults to it,
 * and issues closed before the field existed carry null.
 */
async function alreadyClosedResult(storyId, stateReason = null, config) {
  if (stateReason === 'not_planned') {
    const result = {
      storyId,
      standalone: true,
      action: 'noop',
      reason: 'closed-not-planned',
    };
    const terminal = buildTerminalEnvelope({
      storyId,
      status: 'failed',
      phase: 'init',
      failure: {
        reason:
          `Story #${storyId} is closed as not planned (superseded or abandoned) — ` +
          'there is nothing to land. Re-plan it as a new Story, or pass a Story that is still open.',
      },
      nextCommand: null,
      elapsedSeconds: 0,
    });
    await emitTerminal({ terminal, result, config });
    return { success: false, result, terminal };
  }

  const result = {
    storyId,
    standalone: true,
    action: 'noop',
    reason: 'already-closed',
  };
  // Idempotent re-run against a Story closed as completed. `landed` is the
  // honest status — the issue closed on merge, so the work is on the base
  // branch — and there is nothing left to command.
  const terminal = buildTerminalEnvelope({
    storyId,
    status: 'landed',
    phase: 'done',
    nextCommand: null,
    elapsedSeconds: 0,
  });
  await emitTerminal({ terminal, result, config });
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
  setPhase = () => {},
}) {
  setPhase('wrong-tree-guard');
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
    setPhase('close-validation');
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
    setPhase('base-sync');
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
  setPhase = () => {},
}) {
  setPhase('push');
  pushStoryBranch({ cwd, storyBranch, gitSync, progress });
  setPhase('pull-request');
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
  setPhase('code-review');
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
  localCleanupDeferred = false,
  directMerged = false,
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
    // Story #4681 — `gh`'s local head-branch delete failed while the remote
    // merge/arm stood. Surfaced so the land is auditable as
    // merged-with-deferred-cleanup rather than silently degraded.
    localCleanupDeferred,
    // Story #4682 — native auto-merge was unavailable (no branch protection /
    // an already-clean PR), so the PR was landed by a direct squash-merge.
    // Surfaced so a checks-less land is auditable rather than looking like a
    // queued auto-merge that never fired.
    directMerged,
    waitedForMerge,
    merged,
    note: waitedForMerge
      ? 'Close-and-land: PR merge confirmed. Story flipped agent::closing → agent::done, the issue closed (confirmStoryMerged), and the post-land tail ran.'
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
    waitForMergeParam,
    noWaitForMergeParam,
    maxWaitSecondsParam,
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>]',
    );
  }

  // Story #4543 — track the phase so a crash is attributable. The runner
  // deliberately keeps THROWING (the library contract every caller and test
  // relies on: a failed gate must not look like a return value); it only tags
  // the error with the phase it died in, and the CLI boundary turns that into
  // the `failed` terminal envelope. Tagging rather than swallowing is what
  // lets `failed` name its phase without inventing a second success path.
  let phase = 'init';
  const setPhase = (next) => {
    phase = next;
  };
  try {
    return await runClosePipeline({
      options,
      setPhase,
      injectedProvider,
      injectedConfig,
      injectedNotify,
      injectedSync,
      injectedRunCodeReview,
      injectedGh,
      injectedGitSpawn,
      injectedReleaseLease,
    });
  } catch (err) {
    if (err && typeof err === 'object' && !err.closePhase) {
      err.closePhase = phase;
    }
    throw err;
  }
}

/**
 * The close pipeline proper. Split out of `runSingleStoryClose` so the
 * phase-tagging wrapper above stays a thin, obviously-correct boundary rather
 * than a try block wrapped around a hundred lines of pipeline.
 */
async function runClosePipeline({
  options,
  setPhase,
  injectedProvider,
  injectedConfig,
  injectedNotify,
  injectedSync,
  injectedRunCodeReview,
  injectedGh,
  injectedGitSpawn,
  injectedReleaseLease,
}) {
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
      story.stateReason === 'not_planned'
        ? `Story #${options.storyId} is closed as not planned — nothing to land.`
        : `Story #${options.storyId} is already closed. Nothing to do.`,
    );
    return await alreadyClosedResult(
      options.storyId,
      story.stateReason,
      config,
    );
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
        setPhase,
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
        setPhase,
      }),
    leaseArgs,
  );
  // Reap the per-Story worktree BEFORE the arm (Story #4681). Arming runs
  // `gh pr merge --auto --squash --delete-branch`, which — against an
  // already-mergeable PR — merges immediately and then shells out to local
  // `git` to drop `story-<id>`. A live worktree still holding that ref makes
  // the local delete fail, `gh` exit non-zero, and the arm read as failed,
  // which used to strand a genuinely merged PR at `agent::blocked`.
  // Pre-empting the hold is the ordering half of the fix (the tolerate half
  // lives in `phases/auto-merge.js`); it is safe here because push and PR
  // creation already made the work durable off-machine, and `isSafeToRemove`
  // still refuses a dirty tree.
  const worktreeReaped = await reapWorktreePhase({
    cwd: options.cwd,
    storyId: options.storyId,
    worktreePath,
    wtIsolation: config.delivery?.worktreeIsolation,
    progress,
    WorktreeManager,
  });
  setPhase('auto-merge');
  const {
    autoMergeEnabled,
    autoMergeReason,
    localCleanupDeferred,
    directMerged,
  } = await runAutoMergePhase({
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
    setPhase('confirm-merge');
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
      localCleanupDeferred,
      directMerged,
      waitedForMerge: true,
      merged: waitOutcome.confirmed === true,
    });
    await emitTerminal({ terminal, result, config });

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
    localCleanupDeferred,
    directMerged,
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
  await emitTerminal({ terminal, result, config });
  progress(
    'DONE',
    `✅ Story #${options.storyId}: PR ready → ${prUrl} (${waitForMergeReason})`,
  );
  return { success: true, result, terminal };
}
