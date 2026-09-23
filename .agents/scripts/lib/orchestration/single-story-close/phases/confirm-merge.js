/**
 * phases/confirm-merge.js — the close-and-land merge wait, the default
 * terminal step of every close (`--no-wait-merge` opts out).
 *
 * Two timing domains: `maxWaitSeconds` bounds THIS invocation (it must fit
 * the host's ~10-min tool ceiling after the close gates) and expires to a
 * resumable `pending` with no mutation; `maxBudgetSeconds` bounds the
 * cumulative wait, anchored at the PR's `createdAt` so resumes don't restart
 * it, and exhausting it is the real give-up (classify, emit, block). The
 * poll is stateless and re-entrant. Async mode only shortens the
 * per-invocation window. Checks are probed every iteration so a red required
 * check fails fast instead of burning the budget.
 *
 * Terminals: `landed` (confirmed, post-land tail ran); `pending` (nothing
 * mutated); `blocked` (classified, `merge.unlanded` emitted, friction posted,
 * Story → `agent::blocked`); `blocked`/`merged-flip-failed` (merged but the
 * `agent::done` write failed — its own event and wording, since the merge
 * is not in question).
 */

import { getCiDelivery } from '../../../config/ci.js';
import { createGh } from '../../../gh-exec.js';
import {
  confirmStoryMerged as defaultConfirmStoryMerged,
  readPrMergeState as defaultReadPrMergeState,
} from '../../../single-story/confirm-merge.js';
import { pollUntil } from '../../../util/poll-loop.js';
import { applyBehindUpdate } from '../../behind-recovery.js';
import { isRerunPermitted } from '../../check-state.js';
import { recordRequiredRed as defaultRecordRequiredRed } from '../../ci-red-handling.js';
import {
  emitMergeFlipFailed as defaultEmitMergeFlipFailed,
  MERGED_FLIP_FAILED_BLOCK_CLASS,
} from '../../lifecycle/emit-merge-flip-failed.js';
import { emitMergeUnlanded as defaultEmitMergeUnlanded } from '../../lifecycle/emit-merge-unlanded.js';
import { classifyMergeBlock as defaultClassifyMergeBlock } from '../../merge-block-class.js';
import {
  ADVISORY_GATE_INCONCLUSIVE_CLASS,
  ADVISORY_GATE_RED_CLASS,
  CHECKS_FAILED_CLASS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_BUDGET_SECONDS,
  decideAdvisoryGateBlock,
  decideMergeWaitFailFast,
  deriveChecksStatus,
  deriveRedHeadRuns,
  isPrMerged,
  MERGE_WAIT_GH_TIMEOUT_MS,
  parseWorkflowRunId,
  pollIntervalMs,
  readRunSummary,
  resolveAdvisoryGateVerdict,
} from '../../merge-poll.js';
import { readMergeQueueState } from '../../merge-queue.js';
import { readProbeRunEvidence } from '../../required-checks.js';
import { NEXT_COMMANDS } from '../../story-deliver-terminal.js';
import {
  postStructuredComment,
  STATE_LABELS,
  transitionTicketState,
} from '../../ticketing.js';
import { disarmAutoMerge } from './auto-merge.js';
import { runPostLandTail as defaultRunPostLandTail } from './post-land.js';

/** Per-invocation bound; fits the host's ~10-min tool ceiling after the gates. */
export const DEFAULT_MAX_WAIT_SECONDS = 300;

/** Async-mode per-invocation cap: long enough to catch an instant merge or red check. */
export const ASYNC_PROBE_WINDOW_SECONDS = 60;

export const DEFAULT_UPDATE_ATTEMPTS = 3;

/**
 * Minimum polls before the cumulative budget may block: the clock is anchored
 * at `createdAt`, so a long-open PR is over budget on its first probe and
 * would otherwise block without ever having waited.
 */
export const MIN_POLLS_BEFORE_BUDGET_BLOCK = 2;

/** Verdict for a PR closed without merging, decided by the wait itself. */
const CLOSED_UNMERGED_BLOCK_CLASS = 'api-race-other';
const CLOSED_UNMERGED_REASON =
  'PR probe error: PR closed without merging (state=CLOSED)';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn-level timeout kills a wedged `gh` child; injected `gh`s are bounded by withGhTimeout. */
const defaultGh = createGh(undefined, { timeoutMs: MERGE_WAIT_GH_TIMEOUT_MS });

/**
 * Wall-clock bound for any `gh` call, including injected ones that may never
 * settle. The losing promise's late rejection is absorbed. The timer is NOT
 * unref'd: for a never-settling call it is the only handle keeping the event
 * loop alive until the timeout fires.
 */
function withGhTimeout(promise, timeoutMs, label) {
  let timer;
  const bounded = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`${label} did not return within ${timeoutMs}ms (timeout)`),
      );
    }, timeoutMs);
    promise.then(resolve, reject);
  }).finally(() => clearTimeout(timer));
  promise.catch(() => {});
  return bounded;
}

/**
 * A string field off a `gh pr view` payload; `""` (gh's unreadable field)
 * counts as absent.
 *
 * @param {unknown} value
 * @param {null|undefined} [absent] `undefined` where absence must not shadow a downstream default.
 * @returns {string|null|undefined}
 */
function readString(value, absent = undefined) {
  return typeof value === 'string' && value ? value : absent;
}

/**
 * `inMergeQueue` for a green open PR, the only state GitHub enqueues from;
 * `undefined` otherwise, so the common poll pays no extra call. An enqueued
 * PR has no auto-merge request and can read BLOCKED — neither is a disarm.
 */
async function readInMergeQueue({
  view,
  checksStatus,
  gh,
  ghTimeoutMs,
  readMergeQueueStateFn,
}) {
  const prNodeId = readString(view?.id);
  if (view?.state !== 'OPEN' || checksStatus !== 'success' || !prNodeId) {
    return undefined;
  }
  const queue = await readMergeQueueStateFn({
    prNodeId,
    gh,
    timeoutMs: ghTimeoutMs,
  });
  return typeof queue?.inQueue === 'boolean' ? queue.inQueue : undefined;
}

/**
 * One probe per poll iteration. A failed or timed-out read degrades to
 * `{ checksStatus: 'pending', error }` so a flaky read is never a verdict.
 *
 * @returns {Promise<object>}
 */
export async function readPrWaitProbe({
  prNumber,
  gh = defaultGh,
  ghTimeoutMs = MERGE_WAIT_GH_TIMEOUT_MS,
  readMergeQueueStateFn = readMergeQueueState,
  readRequiredCheckNamesFn,
}) {
  try {
    const view = await withGhTimeout(
      gh.pr.view(prNumber, [
        'id',
        'state',
        'mergedAt',
        'createdAt',
        'mergeStateStatus',
        'reviewDecision',
        'statusCheckRollup',
        'headRefOid',
      ]),
      ghTimeoutMs,
      `gh pr view ${prNumber}`,
    );
    const checksStatus = deriveChecksStatus(view?.statusCheckRollup);
    return {
      state: readString(view?.state, null),
      mergedAt: readString(view?.mergedAt, null),
      createdAt: readString(view?.createdAt, null),
      mergeStateStatus: readString(view?.mergeStateStatus),
      reviewDecision: readString(view?.reviewDecision),
      checksStatus,
      inMergeQueue: await readInMergeQueue({
        view,
        checksStatus,
        gh,
        ghTimeoutMs,
        readMergeQueueStateFn,
      }),
      // Head-anchored, so superseded/pending runs don't read as red; `null`
      // when the rollup is empty (the consecutive-probe fallback owns that).
      requiredRunEvidence: await readProbeRunEvidence({
        view,
        checksStatus,
        prNumber,
        gh,
        ghTimeoutMs,
        readFn: readRequiredCheckNamesFn,
      }),
      redHeadRuns: deriveRedHeadRuns(view?.statusCheckRollup),
      headSha: readString(view?.headRefOid),
    };
  } catch (err) {
    return {
      state: null,
      mergedAt: null,
      createdAt: null,
      checksStatus: 'pending',
      redHeadRuns: [],
      error: `PR probe failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Resolve posture and budgets from `delivery.mergeWatch.*`. Both overrides
 * (`--max-wait-seconds`, `--merge-watch-mode`) win over config; the mode flag
 * exists because only the orchestrator knows whether a foreground wait is
 * cheap (solo) or serialized dead time (a wave). An explicit max-wait
 * override also beats the async cap.
 *
 * @param {object} [config]
 * @param {number} [maxWaitSecondsOverride]
 * @param {'sync'|'async'} [modeOverride]
 * @returns {{ mode: 'sync'|'async', intervalSeconds: number, maxWaitSeconds: number, maxBudgetSeconds: number, updateAttempts: number }}
 */
export function resolveMergeWaitConfig(
  config,
  maxWaitSecondsOverride,
  modeOverride,
) {
  const mergeWatch = config?.delivery?.mergeWatch ?? {};
  const int = (value, fallback) =>
    Number.isInteger(value) && value >= 1 ? value : fallback;
  const requestedMode = modeOverride ?? mergeWatch.mode;
  const mode = requestedMode === 'async' ? 'async' : 'sync';
  const configuredMaxWait = int(
    maxWaitSecondsOverride,
    int(mergeWatch.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS),
  );
  const maxWaitSeconds =
    mode === 'async' && maxWaitSecondsOverride == null
      ? Math.min(configuredMaxWait, ASYNC_PROBE_WINDOW_SECONDS)
      : configuredMaxWait;
  // An interval longer than the bound would expire every invocation on poll
  // 1, so MIN_POLLS_BEFORE_BUDGET_BLOCK and the budget could never be reached.
  const intervalSeconds = Math.min(DEFAULT_INTERVAL_SECONDS, maxWaitSeconds);
  return {
    mode,
    intervalSeconds,
    maxWaitSeconds,
    maxBudgetSeconds: int(
      mergeWatch.maxBudgetSeconds,
      DEFAULT_MAX_BUDGET_SECONDS,
    ),
    updateAttempts: DEFAULT_UPDATE_ATTEMPTS,
  };
}

/**
 * Budget anchor; without `createdAt` it falls back to this invocation's start
 * (worst case a fresh budget, never a premature block).
 *
 * @returns {number} epoch ms
 */
export function resolveBudgetAnchorMs({ createdAt, fallbackMs }) {
  if (typeof createdAt !== 'string' || !createdAt) return fallbackMs;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/**
 * Advisory-gate remedy: the PR is mergeable (UNSTABLE over a non-required
 * red), so branch protection is not the fault. `inconclusive` never finished
 * and implicates nothing (re-run first); `red` reported a real violation.
 *
 * @param {{ storyId: number, blockClass: string }} args
 * @returns {string}
 */
function advisoryGateRemedy({ storyId, blockClass }) {
  const mergeable =
    'GitHub reports this PR **mergeable regardless** ' +
    '(`mergeStateStatus=UNSTABLE`) — the check that blocked is **advisory** ' +
    '(non-required), so there is nothing wrong with branch protection or the ' +
    'required checks. Close refused to let native auto-merge land the PR ' +
    'over the failure, and disarmed it.';
  const act =
    blockClass === ADVISORY_GATE_INCONCLUSIVE_CLASS
      ? 'The job **failed without finishing** and reported no violation, so ' +
        'nothing here says the change is bad. Re-run it — ' +
        '`--rerun-advisory <n>` on this command, or ' +
        '`delivery.ci.rerunAdvisory` — rather than granting the permanent ' +
        'global exemption `delivery.ci.advisoryAllowlist` is. Merging by ' +
        'hand also lands it.'
      : 'The job reported a real violation, so the change **is** implicated. ' +
        'Fix it and push a new head, merge by hand to land over it ' +
        'deliberately, re-run the job (`--rerun-advisory <n>`, or ' +
        '`delivery.ci.rerunAdvisory`) if you believe it flaked, or exempt ' +
        'the job via `delivery.ci.advisoryAllowlist`.';
  return (
    `${mergeable}\n\n${act}\n\nThen resume the land:\n\n` +
    `\`\`\`bash\n${NEXT_COMMANDS.resumeLand(storyId)}\n\`\`\``
  );
}

/**
 * @param {{ storyId: number, prNumber: number|null, blockClass: string }} args
 * @returns {string}
 */
function unlandedRemedy({ storyId, prNumber, blockClass, redRecord }) {
  if (blockClass === CHECKS_FAILED_CLASS) {
    return checksFailedRemedy({ storyId, prNumber, redRecord });
  }
  if (
    blockClass === ADVISORY_GATE_INCONCLUSIVE_CLASS ||
    blockClass === ADVISORY_GATE_RED_CLASS
  ) {
    return advisoryGateRemedy({ storyId, blockClass });
  }
  return (
    `Resolve the underlying condition (branch protection, required checks, ` +
    `or a manual merge), then resume the land:\n\n` +
    `\`\`\`bash\n${NEXT_COMMANDS.resumeLand(storyId)}\n\`\`\``
  );
}

/**
 * States what the red handling actually did — never claims a disarm or a
 * digest that did not happen — then names both ci-remediation routes.
 *
 * @param {{ storyId: number, prNumber: number|null, redRecord?: object }} args
 * @returns {string}
 */
function checksFailedRemedy({ storyId, prNumber, redRecord }) {
  const disarm = redRecord?.disarm;
  const armLine = disarm?.disarmed
    ? disarm.alreadyUnarmed
      ? 'Auto-merge was already un-armed.'
      : 'Auto-merge was **disarmed**; only a green on a new head SHA, or the one rerun a filed `capacity` / `unreproducible-tier` verdict admits, re-arms it.'
    : `⚠️ Auto-merge could **not** be disarmed (${disarm?.detail ?? 'the red handling did not run'}) — GitHub may still land the PR when the checks read green. Disarm it by hand.`;
  const watch = NEXT_COMMANDS.watchCi(storyId, prNumber);
  const digestLine = redRecord?.digestPaths
    ? `CI digest (run link + failure signature): \`${redRecord.digestPaths.jsonPath}\`.`
    : `⚠️ No CI digest was written (${redRecord?.digestError ?? 'no Story scope'}); \`${watch}\` rewrites it.`;
  return (
    `A required check is **red**. ${armLine}\n\n${digestLine}\n\n` +
    `Per \`.agents/rules/ci-remediation.md\`, either fix the failure and push a new commit on ` +
    `\`story-${storyId}\` (re-running the failed job is forbidden), or — when the root cause is ` +
    `outside this delivery — file it:\n\n` +
    `\`\`\`bash\nnode .agents/scripts/file-ci-gap.js --story ${storyId} --pr ${prNumber} ` +
    `--verdict <verdict> --owner <consumer|framework|platform> --evidence "<proof reading>"\n\`\`\`\n\n` +
    `Then watch the checks with:\n\n\`\`\`bash\n${watch}\n\`\`\``
  );
}

function formatUnlandedFriction({
  storyId,
  prNumber,
  prUrl,
  blockClass,
  reason,
  elapsedSeconds,
  redRecord,
}) {
  const prLabel =
    Number.isInteger(prNumber) && prNumber > 0
      ? `PR #${prNumber}${prUrl ? ` (${prUrl})` : ''}`
      : (prUrl ?? 'the PR');
  const remedy = unlandedRemedy({ storyId, prNumber, blockClass, redRecord });
  return (
    `### close-and-land: merge did not land\n\n` +
    `Story #${storyId}: the close polled ${prLabel} for merge confirmation and ` +
    `gave up after ${elapsedSeconds}s without observing a confirmed merge.\n\n` +
    `**Block class:** \`${blockClass}\`\n\n` +
    `**Reason:** ${reason}\n\n` +
    `Story transitioned to \`agent::blocked\`.\n\n${remedy}`
  );
}

/** Friction for a merge that landed but whose `agent::done` write failed. */
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
 * Best-effort; the id becomes the envelope's `frictionCommentId`.
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

/** Emits `merge.flip-failed` (not `merge.unlanded`); best-effort throughout. */
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
    // The merge is confirmed even if the probe was read before it landed.
    prProbe: { ...(prProbe ?? {}), state: 'MERGED' },
  };
}

/**
 * `--rerun-advisory` beats `delivery.ci.rerunAdvisory`; both default 0
 * because a rerun spends CI minutes. An invalid override falls back to config.
 *
 * @param {object|null} config
 * @param {number} [override]
 * @returns {number} allowance ≥ 0
 */
export function resolveAdvisoryRerunAllowance(config, override) {
  if (Number.isInteger(override) && override >= 0) return override;
  return getCiDelivery(config).rerunAdvisory;
}

/**
 * One observation of a red run; a rerun changes `completedAt`, which tells a
 * fresh verdict from the stale pre-rerun snapshot.
 *
 * @param {{name?: string|null, runId?: number, completedAt?: string}} run
 * @returns {string}
 */
function advisoryRunSignature(run) {
  return `${run?.name ?? '(unnamed)'}@${run?.runId ?? 'no-run'}#${run?.completedAt ?? 'no-stamp'}`;
}

/**
 * Attach each red run's check-run output (the rollup carries none), in one
 * call per head. Block path only; fails open to the unenriched runs, which
 * classify as `advisory-gate-red`.
 *
 * @returns {Promise<Array<object>>} the runs, enriched where output was found
 */
async function enrichRedRunsWithOutput({
  runs,
  headSha,
  gh,
  ghTimeoutMs,
  progress,
}) {
  if (!Array.isArray(runs) || runs.length === 0 || !headSha) return runs ?? [];
  try {
    const raw = await withGhTimeout(
      (gh ?? defaultGh).api({
        endpoint: `/repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`,
      }),
      ghTimeoutMs,
      `gh api check-runs ${headSha}`,
    );
    const payload = JSON.parse(raw?.stdout ?? '{}');
    const byName = new Map();
    for (const checkRun of payload?.check_runs ?? []) {
      if (typeof checkRun?.name === 'string' && checkRun.name) {
        byName.set(checkRun.name, checkRun);
      }
    }
    return runs.map((run) => {
      const summary = readRunSummary(run.name ? byName.get(run.name) : null);
      return summary ? { ...run, summary } : run;
    });
  } catch (err) {
    progress?.(
      'CONFIRM',
      `⚠️ Could not read the advisory check output (${err?.message ?? err}) — ` +
        'classifying from the rollup alone.',
    );
    return runs;
  }
}

/**
 * `rerun-failed-jobs` once per distinct workflow run (not per job).
 *
 * @returns {Promise<boolean>} `false` (incl. no run id) keeps the caller on
 *   the block path — an unspendable allowance must not suppress the gate.
 */
async function rerunAdvisoryRuns({ blockingRuns, gh, ghTimeoutMs, progress }) {
  const runIds = [
    ...new Set(
      blockingRuns
        .map((run) => run?.runId ?? parseWorkflowRunId(run?.detailsUrl))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (runIds.length === 0) {
    progress?.(
      'CONFIRM',
      '⚠️ Advisory rerun requested but no workflow run id is readable on the ' +
        'red run(s) — blocking instead.',
    );
    return false;
  }
  for (const runId of runIds) {
    try {
      await withGhTimeout(
        (gh ?? defaultGh).api({
          method: 'POST',
          endpoint: `/repos/{owner}/{repo}/actions/runs/${runId}/rerun-failed-jobs`,
        }),
        ghTimeoutMs,
        `gh api rerun-failed-jobs ${runId}`,
      );
    } catch (err) {
      progress?.(
        'CONFIRM',
        `⚠️ Advisory rerun of workflow run ${runId} failed (${err?.message ?? err}) — blocking instead.`,
      );
      return false;
    }
  }
  progress?.(
    'CONFIRM',
    `🔁 Re-ran ${runIds.length} failed advisory workflow run(s) [${runIds.join(', ')}] — ` +
      'the merge wait keeps polling inside its existing budget.',
  );
  return true;
}

/**
 * Advisory runs are non-required by construction; a red required check
 * fails fast as `checks-failed` and never reaches the rerun path.
 *
 * @param {{ remaining: number }} rerunState
 * @returns {number}
 */
function advisoryRerunsLeft(rerunState) {
  return isRerunPermitted({ required: false }) ? rerunState.remaining : 0;
}

/**
 * Spend one rerun unit, recording each re-run's signature so the stale
 * snapshot doesn't re-block. Does NOT disarm: a green re-run should land on
 * its own; the armed window is what opting in to `--rerun-advisory` accepts.
 *
 * @returns {Promise<boolean>} `true` when the caller should keep polling.
 */
async function maybeRerunAdvisory({
  rerunState,
  blockingRuns,
  gh,
  ghTimeoutMs,
  progress,
}) {
  if (advisoryRerunsLeft(rerunState) <= 0) return false;
  const rerun = await rerunAdvisoryRuns({
    blockingRuns,
    gh,
    ghTimeoutMs,
    progress,
  });
  if (!rerun) return false;
  rerunState.remaining -= 1;
  for (const run of blockingRuns) {
    rerunState.issued.add(advisoryRunSignature(run));
  }
  return true;
}

/**
 * Advisory-gate terminal for one poll; passes a decided `unlanded` through so
 * the caller stays branch-free (`runMergePoll` is at the cyclomatic ceiling).
 * Skips runs already re-ran, enriches the rest, spends any rerun allowance,
 * and disarms BEFORE returning a block so the PR cannot merge out from under it.
 */
async function resolveAdvisoryUnlanded({
  unlanded,
  probe,
  blockOnAdvisoryFailure,
  advisoryAllowlist,
  rerunState,
  prNumber,
  gh,
  ghTimeoutMs,
  progress,
  disarmAutoMergeFn,
  elapsedSeconds,
}) {
  if (unlanded) return unlanded;
  const advisory = decideAdvisoryGateBlock({
    probe,
    blockOnAdvisoryFailure,
    advisoryAllowlist,
  });
  if (!advisory) return null;
  const pending = advisory.blockingRuns.filter(
    (run) => !rerunState.issued.has(advisoryRunSignature(run)),
  );
  if (pending.length === 0) return null;
  const blockingRuns = await enrichRedRunsWithOutput({
    runs: pending,
    headSha: probe?.headSha,
    gh,
    ghTimeoutMs,
    progress,
  });
  if (
    await maybeRerunAdvisory({
      rerunState,
      blockingRuns,
      gh,
      ghTimeoutMs,
      progress,
    })
  ) {
    return null;
  }
  const verdict = resolveAdvisoryGateVerdict({
    blockingRuns,
    rerunAllowance: rerunState.allowance,
  });
  progress?.('CONFIRM', `🛑 PR #${prNumber}: ${verdict.reason}`);
  await disarmAutoMergeFn({ prNumber, gh, progress });
  return {
    prProbe: probe,
    budget: { exhausted: false, elapsedSeconds },
    blockClassOverride: verdict.blockClass,
    reasonOverride: verdict.reason,
  };
}

/**
 * An enqueued PR reads BLOCKED with every check green, which the classifier
 * would call human-required — but the queue lands it unattended.
 */
function queuedExhaustionVerdict(probe, cumulativeMs) {
  if (probe?.inMergeQueue !== true) return {};
  return {
    blockClassOverride: 'checks-pending-timeout',
    reasonOverride: `PR is still in the merge queue after ${Math.round(cumulativeMs / 1000)} seconds — GitHub merges it when the queue's checks pass; a queued base may need a larger delivery.mergeWatch.maxBudgetSeconds`,
  };
}

/**
 * A `checks-failed` fail-fast is a required-check red, so it gets the same
 * first-red handling as the watcher: disarm, then write the CI digest
 * `file-ci-gap.js` reads. Never throws — the block stands regardless.
 *
 * @returns {Promise<object>} the `recordRequiredRed` outcome.
 */
async function recordChecksFailedRed({
  storyId,
  prNumber,
  probe,
  cwd,
  config,
  gh,
  progress,
  disarmAutoMergeFn,
  recordRequiredRedFn,
}) {
  const failures = (probe?.redHeadRuns ?? []).map((run) => ({
    name: run.name ?? 'unknown',
    outcome: String(run.conclusion ?? 'failure').toLowerCase(),
  }));
  try {
    const record = await recordRequiredRedFn({
      storyId,
      prNumber,
      prRef: String(prNumber),
      failures,
      tempRoot: config?.project?.paths?.tempRoot ?? 'temp',
      cwd,
      headSha: probe?.headSha ?? null,
      disarmFn: () => disarmAutoMergeFn({ prNumber, gh, progress }),
    });
    if (record.digestPaths) {
      progress?.(
        'CONFIRM',
        `🧾 CI failure digest → ${record.digestPaths.jsonPath}`,
      );
    }
    return record;
  } catch (err) {
    const detail = String(err?.message ?? err);
    progress?.(
      'CONFIRM',
      `⚠️ Red-check handling failed (continuing to block): ${detail}`,
    );
    return {
      headSha: probe?.headSha ?? null,
      disarm: { disarmed: false, alreadyUnarmed: false, detail },
      digestPaths: null,
      digestError: detail,
    };
  }
}

/** Classify, emit `merge.unlanded`, post friction, block — all best-effort. */
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
  blockClassOverride,
  reasonOverride,
  redRecord,
}) {
  // A verdict decided at detection is emitted as-is, never re-derived (the
  // classifier reads an advisory-gate PR as healthy); the classifier runs
  // only for arm-failure and budget exhaustion.
  const { blockClass, reason } = blockClassOverride
    ? {
        blockClass: blockClassOverride,
        reason: reasonOverride ?? blockClassOverride,
      }
    : classifyMergeBlockFn({
        armResult,
        prProbe,
        budget,
      });
  const elapsedSeconds = budget?.elapsedSeconds ?? 0;
  // `per-run` | `consecutive-probe` for `checks-failed`; absent otherwise.
  const evidencePath = prProbe?.evidencePath;

  if (Number.isInteger(prNumber) && prNumber > 0) {
    try {
      emitMergeUnlandedFn({
        scope: 'story',
        ticketId: storyId,
        prNumber,
        blockClass,
        reason,
        elapsedSeconds,
        ...(evidencePath ? { evidencePath } : {}),
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
      redRecord,
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
    ...(redRecord ? { redRecord } : {}),
    // The envelope's `pr.state` / `pr.checksStatus` come from here.
    prProbe,
  };
}

/**
 * Update a BEHIND PR, bounded by `updateAttempts`; a failed update is not a
 * terminal (the next poll re-reads) but still counts as an attempt.
 *
 * @returns {Promise<boolean>} whether an update was actually attempted.
 */
async function maybeUpdateBehindPr({
  probe,
  prNumber,
  updatesUsed,
  updateAttempts,
  gh,
  ghTimeoutMs = MERGE_WAIT_GH_TIMEOUT_MS,
  progress,
}) {
  const recovery = await applyBehindUpdate({
    mergeStateStatus: probe.mergeStateStatus,
    updatesUsed,
    maxUpdates: updateAttempts,
    updateBranch: () =>
      withGhTimeout(
        (gh ?? defaultGh).pr.updateBranch(prNumber),
        ghTimeoutMs,
        `gh pr update-branch ${prNumber}`,
      ),
    onBudgetSpent: () =>
      progress?.(
        'CONFIRM',
        `⚠️ PR #${prNumber} is BEHIND but the update budget (${updateAttempts}) is spent — not updating again.`,
      ),
    onUpdated: () =>
      progress?.(
        'CONFIRM',
        `⏫ PR #${prNumber} was BEHIND its base — updated (attempt ${updatesUsed + 1}/${updateAttempts}).`,
      ),
    onUpdateFailed: (detail) =>
      progress?.(
        'CONFIRM',
        `⚠️ gh pr update-branch failed (continuing): ${detail}`,
      ),
  });
  return recovery.attempted;
}

/** Called at most once per wait: the flip, then the post-land tail. */
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
    // Saves confirmation a second `gh pr view`.
    prState: prProbe,
  });

  if (confirmation.merged && confirmation.action === 'flip-failed') {
    // Block explicitly (confirmed:true would strand it at agent::closing),
    // but not as unlanded — the merge landed.
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
    // The observed rollup, not a stamped 'success' (admin merges exist).
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
 * @param {'sync'|'async'} [args.mergeWatchMode]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @param {number} [args.rerunAdvisory]
 * @param {object} [args.injectedGh]
 * @param {Function} [args.injectedNotify]
 * @param {Function} [args.confirmStoryMergedFn] The one shared merged/`agent::done` implementation.
 * @param {Function} [args.readPrWaitProbeFn]
 * @param {Function} [args.readPrMergeStateFn]
 * @param {Function} [args.classifyMergeBlockFn]
 * @param {Function} [args.emitMergeUnlandedFn]
 * @param {Function} [args.runPostLandTailFn]
 * @param {Function} [args.disarmAutoMergeFn]
 * @param {Function} [args.recordRequiredRedFn] The shared first-red handling (disarm + CI digest).
 * @param {(ms: number) => Promise<void>} [args.sleepFn]
 * @param {() => number} [args.nowMsFn]
 * @param {number} [args.ghTimeoutMs] Test seam only, not config.
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
  advisoryGate,
  provider,
  config,
  maxWaitSeconds: maxWaitSecondsOverride,
  mergeWatchMode: mergeWatchModeOverride,
  rerunAdvisory: rerunAdvisoryOverride,
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
  disarmAutoMergeFn = disarmAutoMerge,
  recordRequiredRedFn = defaultRecordRequiredRed,
  sleepFn = defaultSleep,
  nowMsFn = Date.now,
  ghTimeoutMs = MERGE_WAIT_GH_TIMEOUT_MS,
}) {
  // Never armed: nothing to poll, but a terminal is still required.
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
      // Carry the arm phase's advisory verdict and class (which may be
      // `inconclusive`) rather than a generic `arm-failure`.
      ...(autoMergeReason === 'advisory-gate-red'
        ? {
            blockClassOverride: advisoryGate?.blockClass ?? 'advisory-gate-red',
            reasonOverride: advisoryGate?.reason,
          }
        : {}),
    });
  }

  const {
    mode,
    intervalSeconds,
    maxWaitSeconds,
    maxBudgetSeconds,
    updateAttempts,
  } = resolveMergeWaitConfig(
    config,
    maxWaitSecondsOverride,
    mergeWatchModeOverride,
  );
  const { blockOnAdvisoryFailure, advisoryAllowlist } = getCiDelivery(config);
  // Spent across the whole wait, not per poll, so `n` bounds CI minutes.
  const rerunAllowance = resolveAdvisoryRerunAllowance(
    config,
    rerunAdvisoryOverride,
  );
  const rerunState = {
    allowance: rerunAllowance,
    remaining: rerunAllowance,
    issued: new Set(),
  };
  let intervalMs = intervalSeconds * 1000;
  const startedAtMs = nowMsFn();
  let anchorMs = startedAtMs;
  let updatesUsed = 0;
  let polls = 0;
  // Without per-run evidence, fail fast only after two consecutive failing
  // probes an interval apart; reset on any other probe.
  let consecutiveRequiredFailSnapshots = 0;

  progress?.(
    'CONFIRM',
    `⏳ Close-and-land: polling PR #${prNumber} for merge confirmation ` +
      `(mode=${mode}, wait=${maxWaitSeconds}s this invocation, ` +
      `cumulative budget=${maxBudgetSeconds}s)...`,
  );

  /** One iteration: `{ done: false }` or `{ done: true, outcome }`. */
  async function runMergePoll() {
    const probe = await readPrWaitProbeFn({
      prNumber,
      gh: injectedGh,
      ghTimeoutMs,
    });
    polls += 1;
    intervalMs = pollIntervalMs(probe.checksStatus, intervalSeconds);

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

    // Heartbeat: a backgrounded close's output-file growth is its liveness signal.
    progress?.(
      'CONFIRM',
      pollHeartbeat({ polls, prNumber, probe, waitBudget }),
    );

    if (isPrMerged(probe)) {
      return doneWith(
        await onMergeObserved({
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
        }),
      );
    }

    // Each definitive condition fills `unlanded`; one call site below blocks.
    let unlanded = null;

    if (probe.state === 'CLOSED') {
      unlanded = {
        prProbe: probe,
        budget: {
          exhausted: true,
          elapsedSeconds: Math.round(waitedMs / 1000),
        },
        blockClassOverride: CLOSED_UNMERGED_BLOCK_CLASS,
        reasonOverride: CLOSED_UNMERGED_REASON,
      };
    } else {
      // No remaining budget turns a red required check green; fail fast.
      const decision = decideMergeWaitFailFast({
        probe,
        consecutiveRequiredFailSnapshots,
      });
      consecutiveRequiredFailSnapshots =
        decision.consecutiveRequiredFailSnapshots;
      if (decision.failFast) {
        progress?.(
          'CONFIRM',
          decision.evidencePath === 'per-run'
            ? `🛑 PR #${prNumber}: a required check concluded failure with none in flight — failing fast (evidence=per-run).`
            : `🛑 PR #${prNumber}: two consecutive failing check probes without per-run evidence — failing fast (evidence=consecutive-probe).`,
        );
        unlanded = {
          prProbe: decision.prProbe,
          budget: {
            exhausted: false,
            elapsedSeconds: Math.round(waitedMs / 1000),
          },
          blockClassOverride: decision.blockClass,
          reasonOverride: decision.reason,
          redRecord: await recordChecksFailedRed({
            storyId,
            prNumber,
            probe,
            cwd,
            config,
            gh: injectedGh,
            progress,
            disarmAutoMergeFn,
            recordRequiredRedFn,
          }),
        };
      }

      // Advisory gates are usually still QUEUED at arm time, so they redden
      // here, mid-wait, before auto-merge lands over them.
      unlanded = await resolveAdvisoryUnlanded({
        unlanded,
        probe,
        blockOnAdvisoryFailure,
        advisoryAllowlist,
        rerunState,
        prNumber,
        gh: injectedGh,
        ghTimeoutMs,
        progress,
        disarmAutoMergeFn,
        elapsedSeconds: Math.round(waitedMs / 1000),
      });
    }

    if (!unlanded) {
      if (
        await maybeUpdateBehindPr({
          probe,
          prNumber,
          updatesUsed,
          updateAttempts,
          gh: injectedGh,
          ghTimeoutMs,
          progress,
        })
      ) {
        updatesUsed += 1;
      }

      // Cumulative budget exhausted, behind the poll floor.
      if (
        polls >= MIN_POLLS_BEFORE_BUDGET_BLOCK &&
        cumulativeMs + intervalMs > maxBudgetSeconds * 1000
      ) {
        unlanded = {
          prProbe: probe,
          budget: {
            exhausted: true,
            elapsedSeconds: Math.round(cumulativeMs / 1000),
          },
          ...queuedExhaustionVerdict(probe, cumulativeMs),
        };
      }
    }

    if (unlanded) {
      return doneWith(
        await blockOnUnlanded({
          storyId,
          prNumber,
          prUrl,
          ...unlanded,
          provider,
          progress,
          classifyMergeBlockFn,
          emitMergeUnlandedFn,
        }),
      );
    }

    // Invocation bound reached: resumable `pending`, no mutation.
    if (waitedMs + intervalMs > maxWaitSeconds * 1000) {
      progress?.(
        'CONFIRM',
        `⏸  Merge wait bound reached (${waitBudget.waitedSeconds}s of ${maxWaitSeconds}s this invocation; ` +
          `${waitBudget.cumulativeSeconds}s of ${maxBudgetSeconds}s cumulative). PR #${prNumber} still in flight ` +
          `(checks=${probe.checksStatus ?? 'unknown'}). Story stays at agent::closing — resumable.`,
      );
      return doneWith({
        confirmed: false,
        terminal: 'pending',
        reason: `merge wait bound reached with the PR still in flight (checks=${probe.checksStatus ?? 'unknown'})`,
        prProbe: probe,
        waitBudget,
        elapsedSeconds: waitBudget.waitedSeconds,
      });
    }

    return { done: false };
  }

  const tick = await pollUntil({
    fn: async () => {
      try {
        return await runMergePoll();
      } catch (err) {
        // pollUntil treats a throw as a non-match and would spin; carry it out.
        return { done: true, thrown: err };
      }
    },
    predicate: (result) => result?.done === true,
    intervalMs,
    // No pollUntil timeout: the tick owns both bounds and the cadence.
    sleepFn: () => sleepFn(intervalMs),
  });
  if (tick.thrown) throw tick.thrown;
  return tick.outcome;
}

function pollHeartbeat({ polls, prNumber, probe, waitBudget }) {
  return (
    `⏱  poll ${polls}: PR #${prNumber} state=${probe.state ?? 'unknown'} ` +
    `checks=${probe.checksStatus ?? 'unknown'} ` +
    `mergeState=${probe.mergeStateStatus ?? 'unknown'} ` +
    `(${waitBudget.waitedSeconds}s of ${waitBudget.maxWaitSeconds}s this invocation; ` +
    `${waitBudget.cumulativeSeconds}s of ${waitBudget.maxBudgetSeconds}s cumulative)` +
    (probe.error ? ` — probe error: ${probe.error}` : '')
  );
}

function doneWith(outcome) {
  return { done: true, outcome };
}
