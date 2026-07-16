/**
 * phases/confirm-merge.js — headless must-land terminal step (Story #4428,
 * Epic #4425 slice 3: standalone-path must-land terminal step).
 *
 * `runSingleStoryClose` (`../runner.js`) arms GitHub native auto-merge and
 * historically rests the Story at `agent::closing` with the issue OPEN —
 * merge confirmation is a separate manual step
 * (`single-story-confirm-merge.js`) a headless (unattended) run never
 * executes. A hung check or a failed arm then leaves the PR silently open
 * forever with no operator watching.
 *
 * This phase closes that gap. It is the **default terminal step for every
 * run** — attended and headless alike — because `waitForMerge` defaults from
 * `delivery.routing.closeAndLand` (`true`); `--no-wait-merge` is the opt-out,
 * and a PR the operator deliberately left un-armed (`--no-auto-merge` /
 * `autoMerge: "strict"`) resolves to no-wait and rests at `agent::closing`
 * for the human. Instead of returning at `agent::closing`, it polls the armed
 * PR to merge confirmation — reusing the SAME `confirmStoryMerged` flip logic
 * `single-story-confirm-merge.js` calls (Story #4428 AC4: exactly one
 * merged/`agent::done` implementation) — on the
 * `delivery.mergeWatch.intervalSeconds` / `maxBudgetSeconds` cadence
 * (mirroring `MergeWatcher`'s poll/budget shape rather than forking it), and
 * runs the land tail (follow-up capture) on the confirmed path.
 *
 * Terminal outcomes:
 *   - `{ confirmed: true, followUps }` — the PR merged; `confirmStoryMerged`
 *     already flipped `agent::closing → agent::done` and closed the issue,
 *     and the land tail captured Story follow-ups.
 *   - `{ confirmed: false, blockClass, reason }` — the arm failed outright,
 *     the PR closed without merging, or the poll budget was exhausted
 *     first. The block is classified via the shared
 *     `classifyMergeBlock` (`../../merge-block-class.js`), a
 *     `merge.unlanded` lifecycle event is emitted (`scope: 'story'`), a
 *     `friction` comment is posted, and the Story is transitioned to
 *     `agent::blocked`. The caller (`runSingleStoryClose`) throws so the
 *     CLI process exits non-zero — never a silent `agent::closing` rest.
 *   - `{ confirmed: false, blockClass: 'merged-flip-failed' }` — the PR
 *     merged but the `agent::done` label write failed. Reported through its
 *     own `merge.flip-failed` event and friction wording (Story #4539): the
 *     merge landed, so attributing it to an unlanded merge would send the
 *     operator to diagnose branch protection instead of re-running the
 *     idempotent confirm.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import {
  confirmStoryMerged as defaultConfirmStoryMerged,
  readPrMergeState as defaultReadPrMergeState,
} from '../../../single-story/confirm-merge.js';
import { emitMergeUnlanded as defaultEmitMergeUnlanded } from '../../lifecycle/emit-merge-unlanded.js';
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_BUDGET_SECONDS,
  deriveChecksStatus,
} from '../../lifecycle/listeners/merge-watcher.js';
import {
  emitMergeFlipFailed as defaultEmitMergeFlipFailed,
  MERGED_FLIP_FAILED_BLOCK_CLASS,
} from '../../lifecycle/emit-merge-flip-failed.js';
import { classifyMergeBlock as defaultClassifyMergeBlock } from '../../merge-block-class.js';
import { captureFollowUpsAfterConfirm as defaultCaptureFollowUpsAfterConfirm } from '../../story-follow-ups.js';
import {
  postStructuredComment,
  STATE_LABELS,
  transitionTicketState,
} from '../../ticketing.js';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fresh PR probe for terminal classification. Fetches the fields
 * `classifyMergeBlock` keys on (`mergeStateStatus`, `reviewDecision`,
 * `statusCheckRollup` → derived `checksStatus`) so a budget exhaustion
 * is classified from the REAL PR state instead of a hardcoded
 * `checksStatus: 'pending'` stamp (which mislabeled every timeout as
 * `checks-pending-timeout` — a review-required block was never
 * diagnosable). Returns a degraded `{ checksStatus: 'pending', error }`
 * probe when the read itself fails, preserving the prior conservative
 * classification on probe errors.
 */
async function readPrClassificationProbe({ prNumber, gh = defaultGh }) {
  try {
    const view = await gh.pr.view(prNumber, [
      'mergeStateStatus',
      'reviewDecision',
      'statusCheckRollup',
    ]);
    return {
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
      checksStatus: 'pending',
      error: `classification probe failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Resolve the poll cadence from `delivery.mergeWatch.*`, falling back to
 * the same defaults `MergeWatcher` uses when the config key is absent.
 *
 * @param {object} [config]
 * @returns {{ intervalSeconds: number, maxBudgetSeconds: number }}
 */
function resolveMergeWatchCadence(config) {
  const mergeWatch = config?.delivery?.mergeWatch ?? {};
  const intervalSeconds =
    Number.isInteger(mergeWatch.intervalSeconds) &&
    mergeWatch.intervalSeconds >= 1
      ? mergeWatch.intervalSeconds
      : DEFAULT_INTERVAL_SECONDS;
  const maxBudgetSeconds =
    Number.isInteger(mergeWatch.maxBudgetSeconds) &&
    mergeWatch.maxBudgetSeconds >= 1
      ? mergeWatch.maxBudgetSeconds
      : DEFAULT_MAX_BUDGET_SECONDS;
  return { intervalSeconds, maxBudgetSeconds };
}

/**
 * Format the `friction` comment body posted alongside the `agent::blocked`
 * transition when a headless close gives up without a confirmed merge.
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
  return (
    `### headless must-land: merge did not land\n\n` +
    `Story #${storyId}: the headless close polled ${prLabel} for merge ` +
    `confirmation and gave up after ${elapsedSeconds}s without observing a ` +
    `confirmed merge.\n\n` +
    `**Block class:** \`${blockClass}\`\n\n` +
    `**Reason:** ${reason}\n\n` +
    `Story transitioned to \`agent::blocked\`. Resolve the underlying ` +
    `condition (branch protection, required checks, or a manual merge), ` +
    `then re-run \`single-story-confirm-merge.js\` or resume delivery.`
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
    `\`\`\`bash\nnode .agents/scripts/single-story-confirm-merge.js --story ${storyId}\n\`\`\``
  );
}

/**
 * Terminal for a confirmed merge whose `agent::done` flip failed. Emits
 * `merge.flip-failed` (NOT `merge.unlanded` — the merge landed), posts the
 * flip-failed friction, and blocks explicitly. Best-effort throughout: the
 * caller owns the non-zero exit.
 *
 * @returns {Promise<{ confirmed: false, blockClass: string, reason: string, elapsedSeconds: number }>}
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

  try {
    await postStructuredComment(
      provider,
      storyId,
      'friction',
      formatFlipFailedFriction({
        storyId,
        prNumber,
        prUrl,
        reason,
        elapsedSeconds,
      }),
    );
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ Failed to post merge.flip-failed friction comment: ${err?.message ?? err}`,
    );
  }

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
    blockClass: MERGED_FLIP_FAILED_BLOCK_CLASS,
    reason,
    elapsedSeconds,
  };
}

/**
 * Classify the unlanded merge, emit `merge.unlanded`, post a `friction`
 * comment, and transition the Story to `agent::blocked`. Every side effect
 * is best-effort logged rather than thrown — the caller (`runSingleStoryClose`)
 * owns surfacing the non-zero exit via its own throw once this returns.
 *
 * @returns {Promise<{ confirmed: false, blockClass: string, reason: string, elapsedSeconds: number }>}
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

  const body = formatUnlandedFriction({
    storyId,
    prNumber,
    prUrl,
    blockClass,
    reason,
    elapsedSeconds,
  });
  try {
    await postStructuredComment(provider, storyId, 'friction', body);
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ Failed to post merge.unlanded friction comment: ${err?.message ?? err}`,
    );
  }

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

  return { confirmed: false, blockClass, reason, elapsedSeconds };
}

/**
 * Poll an armed standalone-Story PR to merge confirmation, or terminate
 * `agent::blocked` with a classified `merge.unlanded` event.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {number} args.storyId
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
 * @param {Function} [args.readPrMergeStateFn] Test seam for the PR-state reader.
 * @param {Function} [args.classifyMergeBlockFn] Test seam for the classifier.
 * @param {Function} [args.emitMergeUnlandedFn] Test seam for the lifecycle emitter.
 * @param {(ms: number) => Promise<void>} [args.sleepFn] Test seam so the
 *   suite does not actually wait.
 * @param {() => number} [args.nowMsFn] Test seam; returns epoch ms.
 * @returns {Promise<{ confirmed: boolean, action?: string, blockClass?: string, reason?: string, elapsedSeconds?: number }>}
 */
export async function runConfirmMergePhase({
  cwd,
  storyId,
  prNumber,
  prUrl,
  autoMergeEnabled,
  autoMergeReason,
  provider,
  config,
  progress,
  injectedGh,
  injectedNotify,
  confirmStoryMergedFn = defaultConfirmStoryMerged,
  readPrMergeStateFn = defaultReadPrMergeState,
  readPrClassificationProbeFn = readPrClassificationProbe,
  classifyMergeBlockFn = defaultClassifyMergeBlock,
  emitMergeUnlandedFn = defaultEmitMergeUnlanded,
  emitMergeFlipFailedFn = defaultEmitMergeFlipFailed,
  captureFollowUpsAfterConfirmFn = defaultCaptureFollowUpsAfterConfirm,
  sleepFn = defaultSleep,
  nowMsFn = Date.now,
}) {
  // The arm itself never succeeded (gh failure, unparseable PR number, or a
  // deliberate disablement) — there is no "armed but unconfirmed" PR to
  // poll. Headless mode still requires an explicit terminal state, so
  // classify and block immediately rather than resting silently.
  if (!autoMergeEnabled) {
    progress?.(
      'CONFIRM',
      `⚠️ Auto-merge not enabled (${autoMergeReason ?? 'unknown'}) — headless close cannot wait for a merge that was never armed.`,
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

  const { intervalSeconds, maxBudgetSeconds } =
    resolveMergeWatchCadence(config);
  const intervalMs = intervalSeconds * 1000;
  const budgetMs = maxBudgetSeconds * 1000;
  const startedAtMs = nowMsFn();

  progress?.(
    'CONFIRM',
    `⏳ Headless must-land: polling PR #${prNumber} for merge confirmation (budget=${maxBudgetSeconds}s)...`,
  );

  while (true) {
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

    if (confirmation.merged && confirmation.action !== 'flip-failed') {
      progress?.(
        'CONFIRM',
        `✅ Story #${storyId} merge confirmed — agent::done.`,
      );
      // Land tail (Story #4539). `captureFollowUpsAfterConfirm` is the one
      // shared helper both landing surfaces reach: the standalone
      // `single-story-confirm-merge.js` CLI wraps it via
      // `withConfirmFollowUps`, and close-and-land — the default path —
      // calls it here. Before this, capture ran ONLY on the CLI path, which
      // the default is told to skip, so per-Story follow-ups were captured
      // never; and a belated manual confirm could not backfill (the Story is
      // already agent::done, so confirm returns `noop` and the capture's
      // `action === 'done'` gate never opens). It never throws — a flaked
      // capture must not fail a landed merge.
      const followUps = await captureFollowUpsAfterConfirmFn(confirmation, {
        storyId,
        provider,
        config,
        cwd,
        progress,
      });
      return { confirmed: true, action: confirmation.action, followUps };
    }

    if (confirmation.merged && confirmation.action === 'flip-failed') {
      // The PR merged but the agent::closing → agent::done label flip
      // itself threw. Blocking explicitly is right — reporting confirmed:true
      // would strand the Story at agent::closing with no notification, the
      // silent-terminal-state gap Epic #4425 exists to close. Reporting it
      // as UNLANDED was not (Story #4539): the merge landed, so the
      // merge.unlanded event was false and its friction sent the operator to
      // branch protection and required checks instead of the one-line
      // remedy. Terminate explicitly, but with the truth.
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
        elapsedSeconds: Math.round((nowMsFn() - startedAtMs) / 1000),
        provider,
        progress,
        emitMergeFlipFailedFn,
      });
    }

    if (confirmation.reason === 'pr-not-merged') {
      // The PR was closed without merging — a definitive terminal state,
      // not a "still pending" condition the budget should keep waiting
      // on. checksStatus MUST be a non-pending, non-undefined value here
      // (audit-clean-code finding, Epic #4425): classifyMergeBlock's
      // budget-exhausted branch treats an undefined checksStatus as
      // "still pending", which would misclassify this definitive
      // closed-without-merging case as checks-pending-timeout instead
      // of falling through to the api-race-other reason built from
      // prProbe.error below.
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
          elapsedSeconds: Math.round((nowMsFn() - startedAtMs) / 1000),
        },
        provider,
        progress,
        classifyMergeBlockFn,
        emitMergeUnlandedFn,
      });
    }

    const elapsedMs = nowMsFn() - startedAtMs;
    if (elapsedMs + intervalMs > budgetMs) {
      // Terminal classification from the REAL PR state — one fresh probe
      // of the fields classifyMergeBlock keys on, instead of stamping
      // every timeout `checksStatus: 'pending'` (which made a
      // review-required block undiagnosable). The probe degrades to the
      // prior conservative pending stamp when the read itself fails.
      const prProbe = await readPrClassificationProbeFn({
        prNumber,
        gh: injectedGh,
      });
      return blockOnUnlanded({
        storyId,
        prNumber,
        prUrl,
        prProbe,
        budget: {
          exhausted: true,
          elapsedSeconds: Math.round(elapsedMs / 1000),
        },
        provider,
        progress,
        classifyMergeBlockFn,
        emitMergeUnlandedFn,
      });
    }

    await sleepFn(intervalMs);
  }
}
