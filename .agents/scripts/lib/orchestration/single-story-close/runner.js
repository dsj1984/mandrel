import { buildDefaultGates } from '../../close-validation/gates.js';
import { runCloseValidation } from '../../close-validation/runner.js';
import { getCiDelivery } from '../../config/ci.js';
import { resolveWorktreeEnabled } from '../../config/runtime.js';
import { resolveConfig } from '../../config-resolver.js';
import { gh as defaultGh } from '../../gh-exec.js';
import { getStoryBranch, gitSpawn, gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';
import {
  resolveWorkerEffort,
  resolveWorkerModel,
  resolveWorkerTokens,
} from '../../observability/close-telemetry.js';
import { createProvider } from '../../provider-factory.js';
import { flipLabelAndNotify } from '../../single-story/story-merged-notify.js';
import { WorktreeManager } from '../../worktree-manager.js';
import { runCodeReview as runCodeReviewDefault } from '../code-review.js';
import { resolveOperatorFromCandidates } from '../lease-guard-shared.js';
import { resolveRunScopedConfig } from '../run-scoped-config.js';
import {
  acquireStoryLease,
  releaseStoryLease,
} from '../single-story-lease-guard.js';
import { createStoryProgress } from '../story-progress.js';
import { createPhaseTimer } from './phase-timer.js';
import { parsePrNumber } from './phases/code-review.js';
import { runConfirmMergePhase } from './phases/confirm-merge.js';
import {
  finishDeferred,
  finishWithMergeWait,
  finishWithoutMergeWait,
  reportOperatorMergeSkip,
  resolveAutoMergeOutcome,
} from './phases/finish.js';
import { runGraphqlPreflight } from './phases/graphql-preflight.js';
import { openAndReviewPr } from './phases/open-pr.js';
import { parseCloseOptions, resolveWaitForMerge } from './phases/options.js';
import { runPrePushPhases } from './phases/pre-push.js';
import { pickHeadPullRequest } from './phases/pull-request.js';
import { reconcileDoneLabel } from './phases/reconcile-done.js';
import {
  existingWorktreePath,
  resolveStoryWorktree,
} from './phases/worktree-restore.js';
import {
  alreadyClosedResult,
  closeEnvelopeGates,
  preflightBlockedResult,
} from './result.js';
import { discardHeldReview } from './review-overlap.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Re-affirm the Story lease before any gate, push or PR write. Close never
 * releases it on a failure — the claim lives from init until the post-land
 * tail — so this is normally `already-held`; it re-takes a claim someone
 * cleared by hand. No steal — a foreign holder throws init's refusal. No
 * configured operator handle skips the acquire, so close never newly
 * hard-fails on it.
 */
async function acquireLease({ storyId }, deps) {
  const operator = resolveOperatorFromCandidates({
    candidates: [deps.config?.github?.operatorHandle],
  });
  if (operator === null) {
    progress(
      'LEASE',
      `⚠️ Story #${storyId} lease not taken: github.operatorHandle is unset.`,
    );
    return null;
  }
  const lease = await deps.acquireLease({
    provider: deps.provider,
    storyId,
    config: deps.config,
    operator,
  });
  progress(
    'LEASE',
    `🔒 Story #${storyId} lease ${lease.reason} (owner=@${lease.owner}).`,
  );
  return lease;
}

/**
 * Tests mock these at their module URLs and re-import only this module, so
 * they are bound here and handed to the phases rather than imported there.
 */
const MODULE_SEAMS = Object.freeze({
  runCloseValidation,
  buildDefaultGates,
  git: Object.freeze({ gitSpawn, gitSync }),
  runConfirmMergePhase,
});

/**
 * An injected double wins, else the real one; an absent optional seam stays
 * `undefined` so its phase applies its own default.
 *
 * @param {{ cwd: string }} options
 * @param {object} injected
 * @returns {object}
 */
function resolveCloseDeps(options, injected) {
  const config = injected.injectedConfig || resolveConfig({ cwd: options.cwd });
  return {
    ...MODULE_SEAMS,
    config,
    provider: injected.injectedProvider || createProvider(config),
    notify: injected.injectedNotify,
    sync: injected.injectedSync,
    runCodeReview: injected.injectedRunCodeReview ?? runCodeReviewDefault,
    gh: injected.injectedGh,
    gitSpawn: injected.injectedGitSpawn,
    acquireLease: injected.injectedAcquireLease ?? acquireStoryLease,
    releaseLease: injected.injectedReleaseLease ?? releaseStoryLease,
    graphqlProbe: injected.injectedGraphqlProbe,
    sleep: injected.injectedSleep,
    runPostLandTail: injected.injectedRunPostLandTail,
  };
}

/** @param {{ storyId?: number|null }} options */
function assertStoryId(options) {
  if (!options.storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--wait-merge|--no-wait-merge] [--max-wait-seconds <n>] [--merge-watch-mode <sync|async>] [--rerun-advisory <n>] [--override-review-block <reason>] [--worker-tokens <n>] [--worker-model <model>] [--worker-effort <level>]',
    );
  }
}

/**
 * Tag a thrown close error with where it stopped and what it observed; the
 * CLI boundary builds the `failed` envelope from these tags.
 */
function tagCloseError(err, { phaseTimer, phase, observedGates }) {
  if (!err || typeof err !== 'object') return;
  err.closePhaseDurations = phaseTimer.finish();
  if (!err.closePhase) err.closePhase = phase;
  if (!err.closeGates && observedGates) err.closeGates = observedGates;
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
  workerTokens: workerTokensParam,
  workerModel: workerModelParam,
  workerEffort: workerEffortParam,
  ...injected
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
    workerTokensParam,
    workerModelParam,
    workerEffortParam,
  });
  assertStoryId(options);

  // The runner keeps THROWING; it only tags the error with its phase and the
  // gates it observed (null until validation reports), and the CLI boundary
  // builds the `failed` envelope from those tags.
  let phase = 'init';
  let observedGates = null;
  const phaseTimer = createPhaseTimer();
  // Inert until the config resolves; no phase is entered before then.
  let storyProgress = { phase() {}, prNumber() {} };
  const setPhase = (next) => {
    phase = next;
    phaseTimer.enter(next);
    storyProgress.phase(next);
  };
  const setObservedGates = (gates) => {
    observedGates = gates;
  };
  try {
    const startedAtMs = Date.now();
    const deps = resolveCloseDeps(options, injected);
    storyProgress = createStoryProgress({
      storyId: options.storyId,
      stage: 'close',
      config: deps.config,
    });
    return await runClosePipeline(
      {
        options,
        setPhase,
        setObservedGates,
        phaseTimer,
        startedAtMs,
        recordPrNumber: storyProgress.prNumber,
      },
      deps,
    );
  } catch (err) {
    tagCloseError(err, { phaseTimer, phase, observedGates });
    throw err;
  }
}

async function loadStoryPhase(ctx, deps) {
  progress('INIT', `Closing standalone Story #${ctx.storyId}...`);
  ctx.story = await deps.provider.getTicket(ctx.storyId);
  if (ctx.story.state !== 'closed') {
    await acquireLease(ctx, deps);
    return null;
  }
  await reconcileDoneLabel(ctx, deps, progress);
  return await alreadyClosedResult(
    ctx.storyId,
    ctx.story.stateReason,
    deps.config,
    ctx.worker,
  );
}

/** One cheap GraphQL read here beats the gate chain plus a push. */
async function graphqlPreflightPhase(ctx, deps) {
  const preflight = await runGraphqlPreflight({
    storyId: ctx.storyId,
    provider: deps.provider,
    progress,
    ghFacade: deps.gh,
    probe: deps.graphqlProbe,
  });
  // The claim stays: the Story is `agent::blocked`, and the assignee is the
  // record of who owns it until the merge lands.
  if (!preflight) return null;
  return await preflightBlockedResult({
    storyId: ctx.storyId,
    preflight,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    worker: ctx.worker,
  });
}

/**
 * The base the run was SEEDED from (init receipt); throws before any merge
 * when it disagrees with current config. Also the Story worktree every later
 * phase runs in — recreated before any git operation when it is missing.
 */
async function resolveBasePhase(ctx, deps) {
  const { values, confirmed } = await resolveRunScopedConfig({
    storyId: ctx.storyId,
    config: deps.config,
    progress,
  });
  ctx.baseBranch = values.baseBranch;
  ctx.baseConfirmed = confirmed;
  ctx.worktreePath = await resolveCloseWorktree(ctx, deps);
  return null;
}

/**
 * A surviving local ref, or a branch still on origin, may carry work no PR
 * holds yet. Only `ls-remote`'s "no such ref" (exit 2) proves the remote
 * branch gone — a read failure counts as surviving.
 */
function storyBranchSurvives(ctx) {
  const cwd = ctx.options.cwd;
  const ref = `refs/heads/${ctx.storyBranch}`;
  const local = gitSpawn(cwd, 'show-ref', '--verify', '--quiet', ref);
  if (local.status === 0) return true;
  const remote = gitSpawn(
    cwd,
    'ls-remote',
    '--exit-code',
    '--heads',
    'origin',
    ctx.storyBranch,
  );
  return remote.status !== 2;
}

/**
 * The Story's PR, when it already merged and nothing newer is in flight — a
 * re-run after the land, whose branch `--delete-branch` and a sweep removed.
 * An OPEN PR on the head wins (a re-delivery), as `ensurePullRequestWith`
 * decides, and a surviving branch means there may be work to deliver.
 * Any read failure reads as "not merged": the normal path then decides.
 *
 * @returns {Promise<{ prUrl: string, prNumber: number|null }|null>}
 */
async function findLandedPr(ctx, deps) {
  if (storyBranchSurvives(ctx)) return null;
  try {
    const rows = await (deps.gh ?? defaultGh).pr.list(
      ['--head', ctx.storyBranch, '--state', 'all'],
      ['url', 'state', 'mergedAt'],
    );
    const head = pickHeadPullRequest(rows);
    return head?.state === 'MERGED'
      ? { prUrl: head.url, prNumber: parsePrNumber(head.url) }
      : null;
  } catch {
    return null;
  }
}

/**
 * A missing worktree is recreated — unless the PR already merged, which
 * short-circuits to the confirm before any restore is attempted.
 */
async function resolveCloseWorktree(ctx, deps) {
  const cwd = ctx.options.cwd;
  const wtIsolation = deps.config.delivery?.worktreeIsolation;
  const missing =
    !existingWorktreePath({ cwd, wtIsolation, storyId: ctx.storyId }) &&
    resolveWorktreeEnabled({ config: deps.config });
  ctx.landedPr = missing ? await findLandedPr(ctx, deps) : null;
  if (ctx.landedPr) {
    ctx.recordPrNumber(ctx.landedPr.prNumber);
    return null;
  }
  return await resolveStoryWorktree({
    cwd,
    config: deps.config,
    storyId: ctx.storyId,
    storyBranch: ctx.storyBranch,
    progress,
    gitSpawn,
    WorktreeManager,
  });
}

/** A landed PR has nothing left to validate, push or open. */
function unlessLanded(phase, onLanded) {
  return (ctx, deps) => (ctx.landedPr ? onLanded(ctx) : phase(ctx, deps));
}

function landedPrePush(ctx) {
  progress(
    'INIT',
    `⏭  PR ${ctx.landedPr.prUrl} already merged — skipping validation, sync and push.`,
  );
  ctx.options = { ...ctx.options, skipValidation: true, skipSync: true };
  ctx.prePush = {
    validationGates: null,
    lockWait: null,
    suiteTimings: null,
    pending: false,
  };
  return null;
}

function landedPr(ctx) {
  ctx.pr = { ...ctx.landedPr, alreadyMerged: true, reviewOverride: null };
  return null;
}

async function prePushPhase(ctx, deps) {
  // A throw here (a red gate, a wrong-tree refusal, a base-sync conflict)
  // keeps the lease: the label still says the Story is owned.
  ctx.prePush = await runPrePushPhases(ctx, deps);
  if (!ctx.prePush.pending) return null;
  discardHeldReview(ctx.heldReview, 'validation pending', progress);
  return await finishDeferred(ctx.prePush.lockWait, {
    storyId: ctx.storyId,
    storyBranch: ctx.storyBranch,
    baseBranch: ctx.baseBranch,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    phaseTimer: ctx.phaseTimer,
    worker: ctx.worker,
  });
}

async function openPrPhase(ctx, deps) {
  ctx.pr = await openAndReviewPr(ctx, deps);
  return null;
}

/**
 * No lease release here: only the post-land tail releases it. The Story
 * worktree is still live at the arm, and that is safe: a `gh pr merge
 * --delete-branch` whose only failure is the LOCAL delete of a branch the
 * worktree holds is classified `localCleanupDeferred` (`LOCAL_CLEANUP_FAILURE`
 * in `phases/auto-merge.js`), and the tail reaps the worktree, then the ref.
 */
async function armPhase(ctx, deps) {
  ctx.setPhase('auto-merge');
  const ciDelivery = getCiDelivery(deps.config);
  const { prUrl, prNumber, alreadyMerged } = ctx.pr;
  ctx.arm = await resolveAutoMergeOutcome({
    alreadyMerged,
    cwd: ctx.options.cwd,
    prNumber,
    prUrl,
    noAutoMerge: ctx.options.noAutoMerge,
    autoMergePolicy: ciDelivery.autoMerge,
    blockOnAdvisoryFailure: ciDelivery.blockOnAdvisoryFailure,
    advisoryAllowlist: ciDelivery.advisoryAllowlist,
    gh: deps.gh,
    progress,
  });
  await flipLabelAndNotify({
    provider: deps.provider,
    notifyFn: deps.notify,
    storyId: ctx.storyId,
    story: ctx.story,
    prUrl,
    autoMergeEnabled: ctx.arm.autoMergeEnabled,
    autoMergeReason: ctx.arm.autoMergeReason,
    config: deps.config,
    progress,
  });
  return null;
}

/** The PR-level facts every finish path reports. */
function buildPrContext(ctx, deps) {
  const { options, arm } = ctx;
  return {
    storyId: ctx.storyId,
    storyBranch: ctx.storyBranch,
    baseBranch: ctx.baseBranch,
    prNumber: ctx.pr.prNumber,
    prUrl: ctx.pr.prUrl,
    autoMergeEnabled: arm.autoMergeEnabled,
    autoMergeReason: arm.autoMergeReason,
    advisoryGate: arm.advisoryGate,
    worktreePath: ctx.worktreePath,
    localCleanupDeferred: arm.localCleanupDeferred,
    directMerged: arm.directMerged,
    config: deps.config,
    startedAtMs: ctx.startedAtMs,
    phaseTimer: ctx.phaseTimer,
    worker: ctx.worker,
    lockWait: ctx.prePush.lockWait,
    suiteTimings: ctx.prePush.suiteTimings,
    gates: closeEnvelopeGates(
      options,
      ctx.prePush.validationGates,
      ctx.pr.reviewOverride,
      ctx.pr.reviewDegraded,
    ),
  };
}

/** Resolve wait-for-merge from the arm outcome and tell the operator why. */
function decideWaitForMerge(ctx, deps) {
  const { options, arm } = ctx;
  const decision = resolveWaitForMerge({
    waitForMergeExplicit: options.waitForMergeExplicit,
    noWaitForMerge: options.noWaitForMerge,
    config: deps.config,
    autoMergeReason: arm.autoMergeReason,
  });
  reportOperatorMergeSkip({
    waitForMergeReason: decision.reason,
    autoMergeReason: arm.autoMergeReason,
    storyId: ctx.storyId,
    waitForMergeExplicit: options.waitForMergeExplicit,
  });
  return decision;
}

/** Wait-for-merge needs the arm outcome, so it is resolved here. */
async function finishPhase(ctx, deps) {
  const { options } = ctx;
  const { waitForMerge, reason } = decideWaitForMerge(ctx, deps);
  const prCtx = buildPrContext(ctx, deps);
  if (!waitForMerge) {
    return await finishWithoutMergeWait(prCtx, reason);
  }
  return await finishWithMergeWait(prCtx, {
    cwd: options.cwd,
    provider: deps.provider,
    maxWaitSeconds: options.maxWaitSeconds,
    mergeWatchMode: options.mergeWatchMode,
    rerunAdvisory: options.rerunAdvisory,
    setPhase: ctx.setPhase,
    injectedGh: deps.gh,
    injectedNotify: deps.notify,
    runConfirmMergePhase: deps.runConfirmMergePhase,
    // The land tail is the one place the claim is released.
    releaseLease: deps.releaseLease,
  });
}

/** Each phase extends the shared context; a non-null return ends the run. */
const CLOSE_PIPELINE = Object.freeze([
  loadStoryPhase,
  graphqlPreflightPhase,
  resolveBasePhase,
  unlessLanded(prePushPhase, landedPrePush),
  unlessLanded(openPrPhase, landedPr),
  armPhase,
  finishPhase,
]);

/**
 * @param {object} run
 * @param {object} deps
 * @returns {Promise<{ success: boolean, result: object, terminal: object }>}
 */
async function runClosePipeline(run, deps) {
  const ctx = {
    ...run,
    storyId: run.options.storyId,
    storyBranch: getStoryBranch(run.options.storyId),
    worker: {
      workerTokens: resolveWorkerTokens(run.options.workerTokens),
      workerModel: resolveWorkerModel(run.options.workerModel),
      workerEffort: resolveWorkerEffort(run.options.workerEffort),
    },
  };
  for (const phase of CLOSE_PIPELINE) {
    const ending = await phase(ctx, deps);
    if (ending) return ending;
  }
}
