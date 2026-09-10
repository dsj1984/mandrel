import nodeFs from 'node:fs';
import path from 'node:path';
import {
  BASELINES_GATE_NAMES,
  buildDefaultGates,
} from '../../close-validation/gates.js';
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
import { resolveRunScopedConfig } from '../run-scoped-config.js';
import { releaseStoryLease } from '../single-story-lease-guard.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  NEXT_COMMANDS,
  terminalFromWaitOutcome,
} from '../story-deliver-terminal.js';
import { deriveCloseNote } from './close-note.js';
import { runAutoMergePhase } from './phases/auto-merge.js';
import { runBaseSyncPhase } from './phases/base-sync.js';
import { runCloseValidationPhase } from './phases/close-validation.js';
import { parsePrNumber, runStoryScopeReview } from './phases/code-review.js';
import { runConfirmMergePhase } from './phases/confirm-merge.js';
import { parseCloseOptions, resolveWaitForMerge } from './phases/options.js';
import { ensurePullRequestWith } from './phases/pull-request.js';
import { pushStoryBranch } from './phases/push.js';
import { handleCriticalReviewBlock } from './phases/review-block.js';
import { handleOverriddenReviewBlock } from './phases/review-override.js';
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
  emitTerminalEnvelope(terminal, { config });
  await emitTerminalFriction({ envelope: terminal, config });
}

/**
 * Terminal for a Story that was already closed before this run started.
 *
 * `state: 'closed'` alone does NOT mean the work landed. GitHub closes an
 * issue as `completed` (the `Closes #<id>` footer firing on merge — the work
 * IS on the base branch) or as `not_planned` (superseded by a re-plan,
 * abandoned — nothing ever merged). Reporting the second as `landed` told
 * `/mandrel-deliver` that work had reached `main` when no PR ever merged, which would
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

/**
 * Project the baselines entries out of close-validation's per-gate outcomes,
 * keyed by the gate's own name (Story #5172).
 *
 * The envelope's `gates` map used to roll the whole gate chain up into a
 * single `validation` verdict, which was fine while the baselines gate was
 * one entry and stopped being fine when it became two: a reader of a failed
 * close could not tell whether the cheap coverage-independent baselines had
 * breached or the expensive coverage-consuming ones had. Only registered
 * entries are reported — a consumer whose config registers just one of the
 * pair gets just that one, never a phantom key for a gate that never existed.
 *
 * @param {Record<string, string>|null|undefined} validationGates
 * @returns {Record<string, string>}
 */
function baselinesEnvelopeGates(validationGates) {
  const registered = Object.values(BASELINES_GATE_NAMES);
  const out = {};
  for (const [name, outcome] of Object.entries(validationGates ?? {})) {
    if (registered.includes(name)) out[name] = outcome;
  }
  return out;
}

function resolveWorktreePath({ cwd, config, storyId }) {
  const root = config.delivery?.worktreeIsolation?.root ?? '.worktrees';
  const candidate = path.resolve(cwd, root, `story-${storyId}`);
  return nodeFs.existsSync(candidate) ? candidate : null;
}

/**
 * The pre-push phases, in the order the pipeline walks them: wrong-tree
 * guard → base-sync → close-validation.
 *
 * Story #5172 put base-sync AHEAD of close-validation, for two reasons that
 * are really one. The cheap one: a base-sync conflict is a hard block that
 * costs nothing to detect, so paying for the full gate chain before
 * discovering it burns the pipeline's most expensive minutes on a tree that
 * was never going to be pushed. The load-bearing one: with the gates last,
 * **the validated tree is the pushed tree**. Under the old order the merge
 * commit base-sync writes landed AFTER validation, so every close pushed a
 * tree no gate had ever seen.
 *
 * `--skip-sync` and `--skip-validation` stay independent — either, both or
 * neither may be set, and each still elides exactly its own phase.
 *
 * @returns {Promise<{ validationGates: Record<string, string>|null }>}
 *   The per-gate outcomes close-validation observed, or `null` when the phase
 *   was skipped. Feeds the terminal envelope's `gates` map so the split
 *   baselines entries are separable there.
 */
async function runPrePushPhases({
  cwd,
  worktreePath,
  config,
  baseBranch,
  baseConfirmed,
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
  if (!skipSync) {
    setPhase('base-sync');
    await runBaseSyncPhase({
      cwd,
      worktreePath,
      baseBranch,
      baseConfirmed,
      storyBranch,
      storyId,
      provider,
      injectedSync,
      progress,
    });
  } else {
    progress('SYNC', '⏭ Skipped (--skip-sync).');
  }
  if (skipValidation) {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
    return { validationGates: null };
  }
  setPhase('close-validation');
  const validation = await runCloseValidationPhase({
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
  return { validationGates: validation?.gates ?? null };
}

async function openAndReviewPr({
  cwd,
  worktreePath,
  story,
  storyId,
  storyBranch,
  baseBranch,
  provider,
  config,
  overrideReviewBlock,
  injectedGh,
  injectedRunCodeReview,
  setPhase = () => {},
}) {
  setPhase('push');
  // Issue #4990 — push from the Story worktree so `pre-push` measures the
  // tree being sent. `gh` and the review's ref-based diffs below keep the
  // caller's `cwd`: they read the shared `.git`, so they resolve identically
  // from either tree.
  pushStoryBranch({ cwd, worktreePath, storyBranch, gitSync, progress });
  setPhase('pull-request');
  const { url: prUrl, alreadyMerged } = await ensurePullRequestWith({
    cwd,
    storyId,
    storyTitle: story.title,
    // Scanned for a declared `BREAKING CHANGE:` footer — see pull-request.js.
    storyBody: story.body,
    storyBranch,
    baseBranch,
    gh: injectedGh,
    progress,
  });
  const prNumber = parsePrNumber(prUrl);
  // Story #4873 — the head's PR already merged (an armed PR that landed while
  // a previous close invocation was between phases). There is nothing left to
  // review and nothing left to arm; the confirm phase probes the PR, observes
  // MERGED, and lands the Story on the merge that actually happened.
  if (alreadyMerged) {
    return { prUrl, prNumber, alreadyMerged: true };
  }
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
    // The sanctioned override. Checked BEFORE the blocked
    // transition so an overridden run never touches `agent::blocked`: the
    // Story is proceeding, and parking it would make the label lie for the
    // rest of the close.
    if (overrideReviewBlock) {
      const override = await handleOverriddenReviewBlock({
        provider,
        storyId,
        prUrl,
        prNumber,
        criticalCount,
        reason: overrideReviewBlock,
        config,
      });
      return {
        prUrl,
        prNumber,
        alreadyMerged: false,
        reviewOverride: override,
      };
    }
    await handleCriticalReviewBlock({
      provider,
      storyId,
      prUrl,
      criticalCount,
    });
    throw new Error(
      `[single-story-close] Story-scope review reported ${criticalCount} critical blocker(s) on PR ${prUrl}. ` +
        'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/mandrel-deliver`. ' +
        'If you have reviewed a finding and judged it wrong, re-run with ' +
        '`--override-review-block "<reason>"` rather than merging by hand.',
    );
  }
  return { prUrl, prNumber, alreadyMerged: false, reviewOverride: null };
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
 * indefinitely. The standalone lease has **no** TTL to expire by (Story
 * #5006 deleted it): `acquireLease` refuses any foreign assignee outright,
 * so a stranded claim is cleared only by `--steal` or de-assignment. That fail-closed-refuses a different operator who picks up
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
    // Story #5266 — derived from `merged` / `directMerged` / `autoMergeEnabled`,
    // never from `waitedForMerge`. A wait that expired unmerged used to write
    // "PR merge confirmed" beside `merged: false`, and this log is what the
    // operator reads first. See close-note.js for the invariant.
    note: deriveCloseNote({ merged, directMerged, autoMergeEnabled }),
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
  mergeWatchMode: mergeWatchModeParam,
  rerunAdvisory: rerunAdvisoryParam,
  overrideReviewBlock: overrideReviewBlockParam,
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
    mergeWatchModeParam,
    rerunAdvisoryParam,
    overrideReviewBlockParam,
  });
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>] [--merge-watch-mode <sync|async>] [--rerun-advisory <n>] [--override-review-block <reason>]',
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
 * Resolve the arm outcome. An already-merged head PR (Story #4873) has nothing
 * to arm — `gh pr merge` against it fails, which would report the arm as a
 * fault and block a Story whose work is already on the base branch. Skip the
 * arm and let the confirm phase observe the merge that happened.
 *
 * @param {object} args
 * @returns {Promise<{ autoMergeEnabled: boolean, autoMergeReason: string|null,
 *   localCleanupDeferred: boolean, directMerged: boolean }>}
 */
async function resolveAutoMergeOutcome({ alreadyMerged, ...phaseArgs }) {
  if (alreadyMerged) {
    return {
      autoMergeEnabled: true,
      autoMergeReason: null,
      localCleanupDeferred: false,
      directMerged: false,
      advisoryGate: null,
    };
  }
  return await runAutoMergePhase(phaseArgs);
}

/**
 * Report the merge-wait terminal on the progress channel. Three endings, each
 * with its own operator-facing shape — `landed` is done, `pending` is
 * resumable and NOT a failure, anything else is a block naming its class.
 *
 * @param {{ status: string, nextCommand: string, blocked?: {blockClass?: string} }} terminal
 * @param {{ storyId: number, prUrl: string|null }} ctx
 * @returns {void}
 */
function reportWaitTerminal(terminal, { storyId, prUrl }) {
  if (terminal.status === 'landed') {
    progress('DONE', `✅ Story #${storyId}: PR merged → ${prUrl}`);
    return;
  }
  if (terminal.status === 'pending') {
    // NOT a failure and NOT a block — the wait reached the edge of its
    // host slot with the PR healthy and in flight. The CLI maps this to
    // its own exit code so a caller can resume without classifying.
    progress(
      'PENDING',
      `⏸  Story #${storyId}: PR ${prUrl} still in flight — resume with: ${terminal.nextCommand}`,
    );
    return;
  }
  progress(
    'BLOCKED',
    `🛑 Story #${storyId}: PR ${prUrl} did not land ` +
      `(blockClass=${terminal.blocked?.blockClass}). Story is at agent::blocked. ` +
      `Next: ${terminal.nextCommand}`,
  );
}

/**
 * The close-and-land ending (Story #4428): poll the just-armed PR to merge
 * confirmation and emit the terminal the outcome names.
 *
 * @param {object} prCtx  The shared PR/gate context built by the pipeline.
 * @param {object} deps   Runtime seams the confirm phase needs.
 * @returns {Promise<{ success: boolean, result: object, terminal: object }>}
 */
async function finishWithMergeWait(prCtx, deps) {
  deps.setPhase('confirm-merge');
  const waitOutcome = await runConfirmMergePhase({
    cwd: deps.cwd,
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prNumber: prCtx.prNumber,
    prUrl: prCtx.prUrl,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    advisoryGate: prCtx.advisoryGate,
    provider: deps.provider,
    config: prCtx.config,
    maxWaitSeconds: deps.maxWaitSeconds,
    mergeWatchMode: deps.mergeWatchMode,
    rerunAdvisory: deps.rerunAdvisory,
    progress,
    injectedGh: deps.injectedGh,
    injectedNotify: deps.injectedNotify,
  });
  const terminal = terminalFromWaitOutcome({
    waitOutcome,
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prNumber: prCtx.prNumber,
    prUrl: prCtx.prUrl,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    gates: prCtx.gates,
    elapsedSeconds: elapsedSecondsSince(prCtx.startedAtMs),
  });
  const result = closeResult({
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prUrl: prCtx.prUrl,
    prNumber: prCtx.prNumber,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    worktreeReaped: prCtx.worktreeReaped,
    // Story #4860 — the release is a post-land tail step now, so the tail's
    // own per-step boolean IS the answer. A wait that ended anything other
    // than landed never ran the tail, and correctly reports `false`: the
    // claim is still held, by design.
    leaseReleased: waitOutcome.tail?.leaseRelease === true,
    localCleanupDeferred: prCtx.localCleanupDeferred,
    directMerged: prCtx.directMerged,
    waitedForMerge: true,
    merged: waitOutcome.confirmed === true,
  });
  await emitTerminal({ terminal, result, config: prCtx.config });
  reportWaitTerminal(terminal, { storyId: prCtx.storyId, prUrl: prCtx.prUrl });
  return { success: terminal.status === 'landed', result, terminal };
}

/**
 * The no-wait ending — `--no-wait-merge` / operator-merge. The PR is open and
 * a human owns the land. That is a `pending` terminal by definition: the work
 * is not done, nothing is broken, and one named command finishes it — rather
 * than a fourth status invented for this one case.
 *
 * @param {object} prCtx
 * @param {string} waitForMergeReason
 * @returns {Promise<{ success: boolean, result: object, terminal: object }>}
 */
async function finishWithoutMergeWait(prCtx, waitForMergeReason) {
  const result = closeResult({
    storyId: prCtx.storyId,
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    prUrl: prCtx.prUrl,
    prNumber: prCtx.prNumber,
    autoMergeEnabled: prCtx.autoMergeEnabled,
    autoMergeReason: prCtx.autoMergeReason,
    worktreeReaped: prCtx.worktreeReaped,
    // Story #4860 — this is the no-wait ending: the PR is open and a human
    // owns the merge, so the Story stays assigned until the confirm-merge
    // surface lands it and runs the tail.
    leaseReleased: false,
    localCleanupDeferred: prCtx.localCleanupDeferred,
    directMerged: prCtx.directMerged,
  });
  const terminal = buildTerminalEnvelope({
    storyId: prCtx.storyId,
    status: 'pending',
    phase: 'auto-merge',
    storyBranch: prCtx.storyBranch,
    baseBranch: prCtx.baseBranch,
    pr: {
      number: prCtx.prNumber,
      url: prCtx.prUrl ?? null,
      state: 'OPEN',
      autoMergeEnabled: Boolean(prCtx.autoMergeEnabled),
    },
    gates: prCtx.gates,
    nextCommand: NEXT_COMMANDS.confirmMerge(prCtx.storyId),
    elapsedSeconds: elapsedSecondsSince(prCtx.startedAtMs),
  });
  await emitTerminal({ terminal, result, config: prCtx.config });
  progress(
    'DONE',
    `✅ Story #${prCtx.storyId}: PR ready → ${prCtx.prUrl} (${waitForMergeReason})`,
  );
  return { success: true, result, terminal };
}

/**
 * Wall-clock seconds since the close started, rounded — the terminal
 * envelope's `elapsedSeconds`.
 *
 * @param {number} startedAtMs
 * @returns {number}
 */
function elapsedSecondsSince(startedAtMs) {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

/**
 * Announce the operator-merge skip: the PR was deliberately left un-armed, so
 * nothing here can land it and the Story rests at `agent::closing`. No-op on
 * every other wait reason.
 *
 * @param {{ waitForMergeReason: string, autoMergeReason: string|null,
 *   storyId: number, waitForMergeExplicit?: boolean }} args
 * @returns {void}
 */
function reportOperatorMergeSkip({
  waitForMergeReason,
  autoMergeReason,
  storyId,
  waitForMergeExplicit,
}) {
  if (waitForMergeReason !== 'operator-merge') return;
  progress(
    'MERGE',
    `⏭  Not waiting for merge (${autoMergeReason}) — the operator owns this merge; ` +
      `Story #${storyId} rests at agent::closing.` +
      (waitForMergeExplicit === true
        ? ' --wait-merge cannot land a PR that was deliberately left un-armed.'
        : ''),
  );
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

  // Story #4891 — the base branch this run was SEEDED from, read back off the
  // run's `story-init` receipt rather than re-resolved from a config file that
  // may have changed during the whole implementation window. Throws (fail
  // closed, naming both values) when the pin and current config disagree —
  // deliberately here, before the gate chain, format-autofix and base-sync,
  // so a wrong base is never merged into the Story branch. `baseConfirmed`
  // gates the base-merge remediation advice further down.
  const { values: runScoped, confirmed: baseConfirmed } =
    await resolveRunScopedConfig({
      provider,
      storyId: options.storyId,
      config,
      progress,
    });
  const baseBranch = runScoped.baseBranch;

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
  const { validationGates } = await releaseLeaseOnBlock(
    () =>
      runPrePushPhases({
        ...options,
        config,
        baseBranch,
        baseConfirmed,
        storyBranch,
        provider,
        worktreePath,
        injectedSync,
        injectedGitSpawn,
        setPhase,
      }),
    leaseArgs,
  );

  const { prUrl, prNumber, alreadyMerged, reviewOverride } =
    await releaseLeaseOnBlock(
      () =>
        openAndReviewPr({
          cwd: options.cwd,
          worktreePath,
          story,
          storyId: options.storyId,
          storyBranch,
          baseBranch,
          provider,
          config,
          overrideReviewBlock: options.overrideReviewBlock,
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
  const ciDelivery = getCiDelivery(config);
  const {
    autoMergeEnabled,
    autoMergeReason,
    localCleanupDeferred,
    directMerged,
    advisoryGate,
  } = await resolveAutoMergeOutcome({
    alreadyMerged,
    cwd: options.cwd,
    prNumber,
    prUrl,
    noAutoMerge: options.noAutoMerge,
    autoMergePolicy: ciDelivery.autoMerge,
    // Story #5096 — the pre-arm advisory-gate refusal.
    blockOnAdvisoryFailure: ciDelivery.blockOnAdvisoryFailure,
    advisoryAllowlist: ciDelivery.advisoryAllowlist,
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
  // Story #4860 — the clean-path lease release USED to sit here, immediately
  // after the arm and the `agent::closing` flip. That dropped the operator's
  // claim the moment the PR opened, so a ticket read unassigned for the whole
  // time its PR was in flight — and forever on the operator-merge path, where
  // nothing downstream ever re-claimed it. The release now belongs to the
  // post-land tail, which runs only on a CONFIRMED merge and which both
  // landing surfaces reach. Every non-merged ending below — the
  // `merge.unlanded` block, an exhausted wait budget, `--no-wait-merge`,
  // `--no-auto-merge` — deliberately RETAINS the claim: the PR is open and the
  // work still has an owner. The only releases that survive here are
  // `releaseLeaseOnBlock`'s two throwing exits above, which fire before the PR
  // is ever armed (Story #4257's hand-off property).

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
  reportOperatorMergeSkip({
    waitForMergeReason,
    autoMergeReason,
    storyId: options.storyId,
    waitForMergeExplicit: options.waitForMergeExplicit,
  });
  const prCtx = {
    storyId: options.storyId,
    storyBranch,
    baseBranch,
    prNumber,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    advisoryGate,
    worktreeReaped,
    localCleanupDeferred,
    directMerged,
    config,
    startedAtMs,
    gates: {
      validation: options.skipValidation ? 'skipped' : 'passed',
      // Story #5172 — the split baselines entries, named individually so a
      // reader can tell the two apart. Absent when validation was skipped.
      ...baselinesEnvelopeGates(validationGates),
      baseSync: options.skipSync ? 'skipped' : 'passed',
      // An overridden blocker reports `overridden`, never
      // `passed`. The review DID fail; a human authorized shipping anyway, and
      // the envelope is the machine-readable trail that says so.
      codeReview: reviewOverride ? 'overridden' : 'passed',
    },
  };

  if (waitForMerge) {
    return await finishWithMergeWait(prCtx, {
      cwd: options.cwd,
      provider,
      maxWaitSeconds: options.maxWaitSeconds,
      mergeWatchMode: options.mergeWatchMode,
      rerunAdvisory: options.rerunAdvisory,
      setPhase,
      injectedGh,
      injectedNotify,
    });
  }
  return await finishWithoutMergeWait(prCtx, waitForMergeReason);
}
