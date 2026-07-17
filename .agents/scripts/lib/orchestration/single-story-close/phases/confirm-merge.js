/**
 * phases/confirm-merge.js — the close-and-land merge wait (Story #4428,
 * reworked into a resumable, checks-aware wait by Story #4543).
 *
 * This is the **default terminal step for every run** — attended and
 * headless alike — because `waitForMerge` defaults from
 * `delivery.routing.closeAndLand` (`true`); `--no-wait-merge` is the opt-out,
 * and a PR the operator deliberately left un-armed (`--no-auto-merge` /
 * `autoMerge: "strict"`) resolves to no-wait and rests at `agent::closing`
 * for the human.
 *
 * ## The timing model (Story #4543 — the load-bearing design decision)
 *
 * The original wait polled a single budget: `maxBudgetSeconds`, one hour.
 * The host caps a single tool invocation at ~10 minutes, and the close gates
 * burn minutes of that before the wait even starts. So a close-and-land
 * whose CI took longer than roughly eight minutes was **killed mid-poll**
 * with no terminal path taken — no `merge.unlanded` event, no `agent::blocked`
 * flip, the Story parked at `agent::closing`: precisely the strand the
 * must-land contract exists to eliminate.
 *
 * The fix splits the two timing domains that were conflated:
 *
 *   - **`maxWaitSeconds`** bounds THIS invocation (default 300s, comfortably
 *     inside the host ceiling). On expiry the wait returns
 *     `terminal: 'pending'` — **no label mutation, no `merge.unlanded`
 *     event** — and the caller surfaces a resumable terminal with its own
 *     exit code. Merely shrinking `maxBudgetSeconds` instead would have been
 *     wrong: that path conflates slow CI with a hard block, so most runs
 *     would have been misfiled as blocked.
 *   - **`maxBudgetSeconds`** bounds the CUMULATIVE wait, anchored at the
 *     PR's `createdAt` rather than this invocation's start, so resumes do not
 *     restart the clock. Exhausting it is the genuine give-up: classify,
 *     emit, block. `agent::blocked` stays reserved for hard blocks.
 *
 * Backgrounding is not a workaround here and does not need to be: an
 * interrupted poll is stateless and re-entrant by construction.
 *
 * ## The wait is not weaker than the watch it displaced
 *
 * The pre-#4543 poll read only `state` / `mergedAt`. A check that went red
 * at minute one therefore burned the full hour and then classified as
 * `branch-protection-human-required` (the exhaustion probe sees
 * `mergeStateStatus: BLOCKED` with checks settled) — sending the operator to
 * diagnose branch protection instead of their red check. This wait probes the
 * checks every iteration: it fails fast on `checks-failed`, and runs a
 * bounded `gh pr update-branch` on a BEHIND PR instead of waiting out the
 * budget behind a base it could have caught up to.
 *
 * The per-iteration `provider.getTicket` is also gone. It was re-fetched
 * every poll for an idempotence check whose answer cannot change mid-poll —
 * ~240 reads per Story per hour. The loop now probes the PR only, and calls
 * the shared `confirmStoryMerged` exactly once, after a merge is observed.
 *
 * Terminal outcomes:
 *   - `{ confirmed: true, action, tail }` — the PR merged; `confirmStoryMerged`
 *     flipped `agent::closing → agent::done` and closed the issue, and the
 *     shared post-land tail ran.
 *   - `{ confirmed: false, terminal: 'pending', waitBudget }` — this
 *     invocation's bound expired with the PR still in flight. Resumable;
 *     nothing was mutated.
 *   - `{ confirmed: false, terminal: 'blocked', blockClass, reason }` — the
 *     arm failed outright, the PR closed without merging, a required check
 *     went red, or the cumulative budget was exhausted. Classified via the
 *     shared `classifyMergeBlock`, emitted as `merge.unlanded`, friction
 *     posted, Story transitioned to `agent::blocked`.
 *   - `{ confirmed: false, terminal: 'blocked', blockClass: 'merged-flip-failed' }`
 *     — the PR merged but the `agent::done` label write failed. Its own
 *     `merge.flip-failed` event and friction wording (Story #4539): the merge
 *     landed, so attributing it to an unlanded merge would send the operator
 *     to diagnose branch protection instead of re-running the idempotent
 *     confirm.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import {
  confirmStoryMerged as defaultConfirmStoryMerged,
  readPrMergeState as defaultReadPrMergeState,
} from '../../../single-story/confirm-merge.js';
import {
  emitMergeFlipFailed as defaultEmitMergeFlipFailed,
  MERGED_FLIP_FAILED_BLOCK_CLASS,
} from '../../lifecycle/emit-merge-flip-failed.js';
import { emitMergeUnlanded as defaultEmitMergeUnlanded } from '../../lifecycle/emit-merge-unlanded.js';
import { classifyMergeBlock as defaultClassifyMergeBlock } from '../../merge-block-class.js';
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_BUDGET_SECONDS,
  deriveChecksStatus,
  failingChecksBlockMerge,
} from '../../merge-poll.js';
import { NEXT_COMMANDS } from '../../story-deliver-terminal.js';
import {
  postStructuredComment,
  STATE_LABELS,
  transitionTicketState,
} from '../../ticketing.js';
import { runPostLandTail as defaultRunPostLandTail } from './post-land.js';

/**
 * Per-invocation merge-wait bound. 300s fits inside a single host tool
 * invocation (~10 min ceiling) with room for the close gates that precede
 * the wait. A headless caller with no such ceiling raises
 * `delivery.mergeWatch.maxWaitSeconds` to keep single-block semantics.
 */
export const DEFAULT_MAX_WAIT_SECONDS = 300;

/** Bounded `gh pr update-branch` attempts for a BEHIND PR. */
export const DEFAULT_UPDATE_ATTEMPTS = 3;

/**
 * Minimum polls before the CUMULATIVE budget may block.
 *
 * The cumulative clock is anchored at the PR's `createdAt` so resumes do not
 * restart it — but that alone means a PR older than `maxBudgetSeconds` (1h by
 * default) is already over budget on its very first probe. Resuming a Story
 * the next morning, or landing a long-open PR, would then flip
 * `agent::blocked` and emit `merge.unlanded` against a perfectly healthy PR
 * that was seconds from merging, without ever having waited.
 *
 * The floor gives every invocation at least one real poll cycle before the
 * cumulative bound can fire. A genuinely stuck PR still blocks within one
 * interval (~30s), so the give-up bound keeps its meaning; a PR about to go
 * green gets the chance it earned.
 */
export const MIN_POLLS_BEFORE_BUDGET_BLOCK = 2;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One probe per poll iteration, carrying every field the loop and the
 * terminal classifier need: merge state, the checks rollup, the merge-state
 * status (for BEHIND recovery and human-required classification), and
 * `createdAt` (the cumulative-budget anchor).
 *
 * Returns a degraded `{ checksStatus: 'pending', error }` probe when the read
 * itself fails, preserving the conservative classification on probe errors —
 * a flaky API read must not be mistaken for a definitive verdict.
 *
 * @returns {Promise<object>}
 */
export async function readPrWaitProbe({ prNumber, gh = defaultGh }) {
  try {
    const view = await gh.pr.view(prNumber, [
      'state',
      'mergedAt',
      'createdAt',
      'mergeStateStatus',
      'reviewDecision',
      'statusCheckRollup',
    ]);
    return {
      state: typeof view?.state === 'string' ? view.state : null,
      mergedAt: typeof view?.mergedAt === 'string' ? view.mergedAt : null,
      createdAt: typeof view?.createdAt === 'string' ? view.createdAt : null,
      mergeStateStatus:
        typeof view?.mergeStateStatus === 'string'
          ? view.mergeStateStatus
          : undefined,
      reviewDecision:
        typeof view?.reviewDecision === 'string'
          ? view.reviewDecision
          : undefined,
      checksStatus: deriveChecksStatus(view?.statusCheckRollup),
    };
  } catch (err) {
    return {
      state: null,
      mergedAt: null,
      createdAt: null,
      checksStatus: 'pending',
      error: `PR probe failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Resolve the wait cadence and both budgets from `delivery.mergeWatch.*`,
 * falling back to the framework defaults when a key is absent or invalid.
 *
 * `maxWaitSecondsOverride` is the per-run `--max-wait-seconds` flag and wins
 * over the config: a headless caller with no host tool-invocation ceiling
 * raises the per-invocation bound to keep single-block semantics without
 * editing the consumer's config.
 *
 * @param {object} [config]
 * @param {number} [maxWaitSecondsOverride]
 * @returns {{ intervalSeconds: number, maxWaitSeconds: number, maxBudgetSeconds: number, updateAttempts: number }}
 */
export function resolveMergeWaitConfig(config, maxWaitSecondsOverride) {
  const mergeWatch = config?.delivery?.mergeWatch ?? {};
  const int = (value, fallback, min = 1) =>
    Number.isInteger(value) && value >= min ? value : fallback;
  const maxWaitSeconds = int(
    maxWaitSecondsOverride,
    int(mergeWatch.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS),
  );
  // A poll interval longer than the wait bound is incoherent, and silently
  // harmful: the pending check would fire on poll 1 every time, so the wait
  // could never sleep, `polls` could never reach
  // MIN_POLLS_BEFORE_BUDGET_BLOCK, and the cumulative budget would become
  // unreachable across ANY number of resumes — a Story stuck in permanent
  // `pending` that never escalates. Clamping the interval to the bound keeps
  // at least one real poll cycle possible, which is what both the floor and
  // the give-up bound depend on.
  const intervalSeconds = Math.min(
    int(mergeWatch.intervalSeconds, DEFAULT_INTERVAL_SECONDS),
    maxWaitSeconds,
  );
  return {
    intervalSeconds,
    maxWaitSeconds,
    maxBudgetSeconds: int(
      mergeWatch.maxBudgetSeconds,
      DEFAULT_MAX_BUDGET_SECONDS,
    ),
    updateAttempts: int(mergeWatch.updateAttempts, DEFAULT_UPDATE_ATTEMPTS, 0),
  };
}

/**
 * Anchor the cumulative budget at the PR's `createdAt` so a resumed wait
 * does not restart the clock. Falls back to this invocation's start when the
 * probe carried no timestamp — a conservative degrade: the worst case is a
 * resume getting a fresh cumulative budget, which is exactly the pre-#4543
 * behaviour, never a premature block.
 *
 * @returns {number} epoch ms
 */
export function resolveBudgetAnchorMs({ createdAt, fallbackMs }) {
  if (typeof createdAt !== 'string' || !createdAt) return fallbackMs;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/**
 * Format the `friction` comment body posted alongside the `agent::blocked`
 * transition when a landing attempt gives up without a confirmed merge.
 */
function formatUnlandedFriction({
  storyId,
  prNumber,
  prUrl,
  blockClass,
  reason,
  elapsedSeconds,
}) {
  const prLabel =
    Number.isInteger(prNumber) && prNumber > 0
      ? `PR #${prNumber}${prUrl ? ` (${prUrl})` : ''}`
      : (prUrl ?? 'the PR');
  const remedy =
    blockClass === 'checks-failed'
      ? `A required check is **red**. Fix the failure and push a new commit on \`story-${storyId}\`; ` +
        `auto-merge stays armed across retries. Watch the checks with:\n\n` +
        `\`\`\`bash\n${NEXT_COMMANDS.watchCi(storyId, prNumber)}\n\`\`\``
      : `Resolve the underlying condition (branch protection, required checks, ` +
        `or a manual merge), then resume the land:\n\n` +
        `\`\`\`bash\n${NEXT_COMMANDS.resumeLand(storyId)}\n\`\`\``;
  return (
    `### close-and-land: merge did not land\n\n` +
    `Story #${storyId}: the close polled ${prLabel} for merge confirmation and ` +
    `gave up after ${elapsedSeconds}s without observing a confirmed merge.\n\n` +
    `**Block class:** \`${blockClass}\`\n\n` +
    `**Reason:** ${reason}\n\n` +
    `Story transitioned to \`agent::blocked\`.\n\n${remedy}`
  );
}

/**
 * Format the `friction` comment for a merge that **landed** while the
 * `agent::done` label write failed. Deliberately not the unlanded wording:
 * the merge is not in question, so pointing the operator at branch
 * protection and required checks would send them to diagnose a fault that
 * does not exist. Name the actual remedy instead.
 */
function formatFlipFailedFriction({
  storyId,
  prNumber,
  prUrl,
  reason,
  elapsedSeconds,
}) {
  const prLabel =
    Number.isInteger(prNumber) && prNumber > 0
      ? `PR #${prNumber}${prUrl ? ` (${prUrl})` : ''}`
      : (prUrl ?? 'the PR');
  return (
    `### merge landed; the agent::done flip failed\n\n` +
    `Story #${storyId}: ${prLabel} **merged successfully** after ${elapsedSeconds}s, ` +
    `but the \`agent::closing\` → \`agent::done\` label write failed. The code is ` +
    `on the base branch — this is a label-write fault, not a merge fault, so ` +
    `there is nothing to diagnose about branch protection or required checks.\n\n` +
    `**Block class:** \`${MERGED_FLIP_FAILED_BLOCK_CLASS}\`\n\n` +
    `**Reason:** ${reason}\n\n` +
    `Story transitioned to \`agent::blocked\` so the merged-but-mislabelled ` +
    `state is explicit rather than silently resting at \`agent::closing\`.\n\n` +
    `**Remedy:** re-run the merge confirmation — it is idempotent and flips ` +
    `the label from the already-merged PR:\n\n` +
    `\`\`\`bash\n${NEXT_COMMANDS.confirmMerge(storyId)}\n\`\`\``
  );
}

/**
 * Post a friction comment best-effort and return its id when the provider
 * surfaces one. The id is the terminal envelope's `frictionCommentId`
 * pointer, so a caller can link the operator straight at the remediation
 * instead of telling them to go find it.
 *
 * @returns {Promise<string|null>}
 */
async function postFriction({ provider, storyId, body, progress }) {
  try {
    const posted = await postStructuredComment(
      provider,
      storyId,
      'friction',
      body,
    );
    const id = posted?.id ?? posted?.commentId ?? null;
    return id == null ? null : String(id);
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ Failed to post friction comment: ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Terminal for a confirmed merge whose `agent::done` flip failed. Emits
 * `merge.flip-failed` (NOT `merge.unlanded` — the merge landed), posts the
 * flip-failed friction, and blocks explicitly. Best-effort throughout: the
 * caller owns the non-zero exit.
 */
async function blockOnFlipFailed({
  storyId,
  prNumber,
  prUrl,
  reason,
  elapsedSeconds,
  provider,
  progress,
  emitMergeFlipFailedFn,
  prProbe,
}) {
  if (Number.isInteger(prNumber) && prNumber > 0) {
    try {
      emitMergeFlipFailedFn({
        scope: 'story',
        ticketId: storyId,
        prNumber,
        reason,
        elapsedSeconds,
      });
    } catch (err) {
      progress?.(
        'CONFIRM',
        `⚠️ merge.flip-failed emit failed (continuing): ${err?.message ?? err}`,
      );
    }
  }

  const frictionCommentId = await postFriction({
    provider,
    storyId,
    body: formatFlipFailedFriction({
      storyId,
      prNumber,
      prUrl,
      reason,
      elapsedSeconds,
    }),
    progress,
  });

  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
    progress?.(
      'CONFIRM',
      `🛑 Story #${storyId} → agent::blocked (${MERGED_FLIP_FAILED_BLOCK_CLASS}) — merge landed, label flip failed.`,
    );
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ Failed to flip Story #${storyId} to agent::blocked: ${err?.message ?? err}`,
    );
  }

  return {
    confirmed: false,
    terminal: 'blocked',
    blockClass: MERGED_FLIP_FAILED_BLOCK_CLASS,
    reason,
    frictionCommentId,
    elapsedSeconds,
    // The merge is CONFIRMED here — only the label write failed — so the
    // envelope must say MERGED even when the probe that got us here was read
    // before the merge landed. Reporting the stale OPEN (or null) would tell
    // the operator to chase a merge that already happened.
    prProbe: { ...(prProbe ?? {}), state: 'MERGED' },
  };
}

/**
 * Classify the unlanded merge, emit `merge.unlanded`, post a `friction`
 * comment, and transition the Story to `agent::blocked`. Every side effect
 * is best-effort logged rather than thrown — the caller owns surfacing the
 * non-zero exit once this returns.
 */
async function blockOnUnlanded({
  storyId,
  prNumber,
  prUrl,
  armResult,
  prProbe,
  budget,
  provider,
  progress,
  classifyMergeBlockFn,
  emitMergeUnlandedFn,
}) {
  const { blockClass, reason } = classifyMergeBlockFn({
    armResult,
    prProbe,
    budget,
  });
  const elapsedSeconds = budget?.elapsedSeconds ?? 0;

  if (Number.isInteger(prNumber) && prNumber > 0) {
    try {
      emitMergeUnlandedFn({
        scope: 'story',
        ticketId: storyId,
        prNumber,
        blockClass,
        reason,
        elapsedSeconds,
      });
    } catch (err) {
      progress?.(
        'CONFIRM',
        `⚠️ merge.unlanded emit failed (continuing): ${err?.message ?? err}`,
      );
    }
  } else {
    progress?.(
      'CONFIRM',
      '⚠️ No parseable PR number — skipping merge.unlanded emit (schema requires prNumber).',
    );
  }

  const frictionCommentId = await postFriction({
    provider,
    storyId,
    body: formatUnlandedFriction({
      storyId,
      prNumber,
      prUrl,
      blockClass,
      reason,
      elapsedSeconds,
    }),
    progress,
  });

  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
    progress?.(
      'CONFIRM',
      `🛑 Story #${storyId} → agent::blocked (${blockClass}).`,
    );
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ Failed to flip Story #${storyId} to agent::blocked: ${err?.message ?? err}`,
    );
  }

  return {
    confirmed: false,
    terminal: 'blocked',
    blockClass,
    reason,
    frictionCommentId,
    elapsedSeconds,
    // The probe the classifier just read. The terminal envelope reports
    // `pr.state` / `pr.checksStatus` from here; dropping it made every
    // blocked envelope claim `null` for facts we had just observed — a
    // `checks-failed` envelope reporting `checksStatus: null` contradicts
    // itself. Schema wants "live PR facts as observed at terminal time".
    prProbe,
  };
}

/**
 * Bring a BEHIND PR up to date, bounded by `updateAttempts`. Best-effort:
 * a failed update is not itself a terminal — the next poll re-reads the
 * real state and lets the normal classification decide.
 *
 * @returns {Promise<boolean>} whether an update was actually attempted.
 */
async function maybeUpdateBehindPr({
  probe,
  prNumber,
  updatesUsed,
  updateAttempts,
  gh,
  progress,
}) {
  if (probe.mergeStateStatus !== 'BEHIND') return false;
  if (updatesUsed >= updateAttempts) {
    progress?.(
      'CONFIRM',
      `⚠️ PR #${prNumber} is BEHIND but the update budget (${updateAttempts}) is spent — not updating again.`,
    );
    return false;
  }
  try {
    await (gh ?? defaultGh).pr.updateBranch(prNumber);
    progress?.(
      'CONFIRM',
      `⏫ PR #${prNumber} was BEHIND its base — updated (attempt ${updatesUsed + 1}/${updateAttempts}).`,
    );
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ gh pr update-branch failed (continuing): ${err?.message ?? err}`,
    );
  }
  return true;
}

/**
 * Handle an observed merge: run the shared `confirmStoryMerged` flip, then
 * the shared post-land tail. Called at most once per wait — the loop probes
 * the PR, not the ticket.
 */
async function onMergeObserved({
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  prUrl,
  cwd,
  config,
  provider,
  progress,
  injectedGh,
  injectedNotify,
  readPrMergeStateFn,
  confirmStoryMergedFn,
  runPostLandTailFn,
  emitMergeFlipFailedFn,
  prProbe,
  elapsedSeconds,
}) {
  const confirmation = await confirmStoryMergedFn({
    provider,
    storyId,
    prNumber,
    prUrl,
    cwd,
    config,
    progress,
    injectedGh,
    injectedNotify,
    readPrMergeStateFn,
  });

  if (confirmation.merged && confirmation.action === 'flip-failed') {
    // The PR merged but the agent::closing → agent::done label flip itself
    // threw. Blocking explicitly is right — reporting confirmed:true would
    // strand the Story at agent::closing with no notification. Reporting it
    // as UNLANDED was not (Story #4539): the merge landed, so the
    // merge.unlanded event would be false and its friction would send the
    // operator to branch protection instead of the one-line remedy.
    progress?.(
      'CONFIRM',
      `⚠️ Story #${storyId} merge confirmed but the agent::done flip failed — blocking explicitly.`,
    );
    return blockOnFlipFailed({
      storyId,
      prNumber,
      prUrl,
      reason:
        confirmation.reason ??
        'merge confirmed but the agent::done label write failed',
      elapsedSeconds,
      provider,
      progress,
      emitMergeFlipFailedFn,
      prProbe,
    });
  }

  progress?.('CONFIRM', `✅ Story #${storyId} merge confirmed — agent::done.`);
  const tail = await runPostLandTailFn({
    storyId,
    storyBranch,
    baseBranch,
    cwd,
    provider,
    config,
    progress,
  });
  return {
    confirmed: true,
    terminal: 'landed',
    action: confirmation.action,
    tail,
    // Carry the OBSERVED rollup rather than stamping 'success'. A merge landed
    // by admin override, or with non-required checks red, must not be reported
    // as a green run nobody actually saw — that is the same
    // report-an-outcome-you-never-checked shape the land tail's per-step
    // booleans exist to prevent.
    prProbe,
  };
}

/**
 * Poll an armed Story PR to merge confirmation, a resumable `pending`
 * expiry, or a classified `agent::blocked` terminal.
 *
 * @param {object} args
 * @param {string} args.cwd            The MAIN checkout.
 * @param {number} args.storyId
 * @param {string} [args.storyBranch]
 * @param {string} [args.baseBranch]
 * @param {number|null} args.prNumber
 * @param {string} args.prUrl
 * @param {boolean} args.autoMergeEnabled
 * @param {string|null} args.autoMergeReason
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @param {object} [args.injectedGh]
 * @param {Function} [args.injectedNotify]
 * @param {Function} [args.confirmStoryMergedFn] Test seam — defaults to the
 *   SAME `confirmStoryMerged` export `single-story-confirm-merge.js` calls
 *   (Story #4428 AC4: one merged/`agent::done` implementation).
 * @param {Function} [args.readPrWaitProbeFn]    Test seam for the poll probe.
 * @param {Function} [args.readPrMergeStateFn]   Test seam for the PR-state reader.
 * @param {Function} [args.classifyMergeBlockFn] Test seam for the classifier.
 * @param {Function} [args.emitMergeUnlandedFn]  Test seam for the emitter.
 * @param {Function} [args.runPostLandTailFn]    Test seam for the land tail.
 * @param {(ms: number) => Promise<void>} [args.sleepFn] Test seam so the
 *   suite does not actually wait.
 * @param {() => number} [args.nowMsFn] Test seam; returns epoch ms.
 * @returns {Promise<object>}
 */
export async function runConfirmMergePhase({
  cwd,
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  prUrl,
  autoMergeEnabled,
  autoMergeReason,
  provider,
  config,
  maxWaitSeconds: maxWaitSecondsOverride,
  progress,
  injectedGh,
  injectedNotify,
  confirmStoryMergedFn = defaultConfirmStoryMerged,
  readPrWaitProbeFn = readPrWaitProbe,
  readPrMergeStateFn = defaultReadPrMergeState,
  classifyMergeBlockFn = defaultClassifyMergeBlock,
  emitMergeUnlandedFn = defaultEmitMergeUnlanded,
  emitMergeFlipFailedFn = defaultEmitMergeFlipFailed,
  runPostLandTailFn = defaultRunPostLandTail,
  sleepFn = defaultSleep,
  nowMsFn = Date.now,
}) {
  // The arm itself never succeeded (gh failure, unparseable PR number, or a
  // deliberate disablement) — there is no "armed but unconfirmed" PR to
  // poll. An explicit terminal state is still required, so classify and
  // block immediately rather than resting silently.
  if (!autoMergeEnabled) {
    progress?.(
      'CONFIRM',
      `⚠️ Auto-merge not enabled (${autoMergeReason ?? 'unknown'}) — cannot wait for a merge that was never armed.`,
    );
    return blockOnUnlanded({
      storyId,
      prNumber,
      prUrl,
      armResult: { armed: false, reason: autoMergeReason },
      budget: { elapsedSeconds: 0 },
      provider,
      progress,
      classifyMergeBlockFn,
      emitMergeUnlandedFn,
    });
  }

  const { intervalSeconds, maxWaitSeconds, maxBudgetSeconds, updateAttempts } =
    resolveMergeWaitConfig(config, maxWaitSecondsOverride);
  const intervalMs = intervalSeconds * 1000;
  const startedAtMs = nowMsFn();
  let anchorMs = startedAtMs;
  let updatesUsed = 0;
  let polls = 0;

  progress?.(
    'CONFIRM',
    `⏳ Close-and-land: polling PR #${prNumber} for merge confirmation ` +
      `(wait=${maxWaitSeconds}s this invocation, cumulative budget=${maxBudgetSeconds}s)...`,
  );

  while (true) {
    const probe = await readPrWaitProbeFn({ prNumber, gh: injectedGh });
    polls += 1;

    // Anchor the cumulative budget at the PR's creation the first time we
    // learn it, so a resumed wait continues the clock instead of restarting.
    anchorMs = resolveBudgetAnchorMs({
      createdAt: probe.createdAt,
      fallbackMs: startedAtMs,
    });

    const waitedMs = nowMsFn() - startedAtMs;
    const cumulativeMs = Math.max(nowMsFn() - anchorMs, waitedMs);
    const waitBudget = {
      maxWaitSeconds,
      waitedSeconds: Math.round(waitedMs / 1000),
      cumulativeSeconds: Math.round(cumulativeMs / 1000),
      maxBudgetSeconds,
    };

    if (probe.state === 'MERGED' || probe.mergedAt) {
      return onMergeObserved({
        storyId,
        storyBranch,
        baseBranch,
        prNumber,
        prUrl,
        cwd,
        config,
        provider,
        progress,
        injectedGh,
        injectedNotify,
        readPrMergeStateFn,
        confirmStoryMergedFn,
        runPostLandTailFn,
        emitMergeFlipFailedFn,
        prProbe: probe,
        elapsedSeconds: Math.round(waitedMs / 1000),
      });
    }

    if (probe.state === 'CLOSED') {
      // Closed without merging — a definitive terminal, not a "still
      // pending" condition the budget should keep waiting on. checksStatus
      // MUST be a non-pending, non-undefined value here: the classifier's
      // budget-exhausted branch treats an undefined checksStatus as "still
      // pending", which would misclassify this definitive case as
      // checks-pending-timeout instead of reaching the api-race-other
      // reason built from prProbe.error.
      return blockOnUnlanded({
        storyId,
        prNumber,
        prUrl,
        prProbe: {
          checksStatus: 'closed',
          error: 'PR closed without merging (state=CLOSED)',
        },
        budget: {
          exhausted: true,
          elapsedSeconds: Math.round(waitedMs / 1000),
        },
        provider,
        progress,
        classifyMergeBlockFn,
        emitMergeUnlandedFn,
      });
    }

    // Fail fast on a red REQUIRED check. No remaining budget turns a failed
    // check green, and waiting it out is what made the pre-#4543 wait report
    // the operator's red test run as a branch-protection block.
    //
    // Gated on `failingChecksBlockMerge`, not on the raw rollup: a red
    // OPTIONAL check does not stop native auto-merge, so failing fast on it
    // would block the Story while the PR lands anyway.
    if (failingChecksBlockMerge(probe)) {
      progress?.(
        'CONFIRM',
        `🛑 PR #${prNumber}: a required check went red — failing fast rather than burning the budget.`,
      );
      return blockOnUnlanded({
        storyId,
        prNumber,
        prUrl,
        prProbe: probe,
        budget: {
          exhausted: false,
          elapsedSeconds: Math.round(waitedMs / 1000),
        },
        provider,
        progress,
        classifyMergeBlockFn,
        emitMergeUnlandedFn,
      });
    }

    if (
      await maybeUpdateBehindPr({
        probe,
        prNumber,
        updatesUsed,
        updateAttempts,
        gh: injectedGh,
        progress,
      })
    ) {
      updatesUsed += 1;
    }

    // Cumulative budget exhausted → the genuine give-up. Classify from the
    // probe we already hold. Gated behind the poll floor so an
    // already-over-budget PR (anchored at a createdAt older than the budget —
    // a resume the next day, or a long-open PR) still gets a real poll cycle
    // instead of being blocked before this invocation waited at all.
    if (
      polls >= MIN_POLLS_BEFORE_BUDGET_BLOCK &&
      cumulativeMs + intervalMs > maxBudgetSeconds * 1000
    ) {
      return blockOnUnlanded({
        storyId,
        prNumber,
        prUrl,
        prProbe: probe,
        budget: {
          exhausted: true,
          elapsedSeconds: Math.round(cumulativeMs / 1000),
        },
        provider,
        progress,
        classifyMergeBlockFn,
        emitMergeUnlandedFn,
      });
    }

    // This invocation's bound expired → PENDING. Deliberately NOT a block:
    // nothing is wrong, the run simply reached the edge of its host slot.
    // No label mutation, no merge.unlanded event — the caller surfaces a
    // resumable terminal and the next invocation continues the cumulative
    // clock from the PR's createdAt.
    if (waitedMs + intervalMs > maxWaitSeconds * 1000) {
      progress?.(
        'CONFIRM',
        `⏸  Merge wait bound reached (${waitBudget.waitedSeconds}s of ${maxWaitSeconds}s this invocation; ` +
          `${waitBudget.cumulativeSeconds}s of ${maxBudgetSeconds}s cumulative). PR #${prNumber} still in flight ` +
          `(checks=${probe.checksStatus ?? 'unknown'}). Story stays at agent::closing — resumable.`,
      );
      return {
        confirmed: false,
        terminal: 'pending',
        reason: `merge wait bound reached with the PR still in flight (checks=${probe.checksStatus ?? 'unknown'})`,
        prProbe: probe,
        waitBudget,
        elapsedSeconds: waitBudget.waitedSeconds,
      };
    }

    await sleepFn(intervalMs);
  }
}
