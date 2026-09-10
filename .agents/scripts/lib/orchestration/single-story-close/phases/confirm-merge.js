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
 * ## Async mode (Story #4698 — a designed short probe window, not an accident)
 *
 * `maxWaitSeconds` (default 300s) still routinely EXPIRES on a slow-CI
 * consumer: the median PR-create→merge time can be minutes, so nearly every
 * close burns its whole foreground slot polling and then returns `pending`
 * anyway. `delivery.mergeWatch.mode: "async"` makes that async confirm a
 * designed mode rather than an expiry accident. It caps the per-invocation
 * wait to a short probe window (`ASYNC_PROBE_WINDOW_SECONDS`, ~60s) — long
 * enough for the loop's existing checks to catch an instant merge and, via the
 * imported {@link decideMergeWaitFailFast} decision (Story #4695/#4710), an
 * instantly-red required check — then returns the SAME resumable `pending`
 * terminal, whose `nextCommand` the worker launches in the background. Nothing
 * else changes: the cumulative `maxBudgetSeconds` anchor is untouched, and
 * `sync` mode (the default) is byte-compatible. An explicit `--max-wait-seconds`
 * override wins over the async cap so a headless caller can still land in one
 * block. The clamp lives entirely in `resolveMergeWaitConfig`; the poll loop is
 * mode-agnostic.
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

import { getCiDelivery } from '../../../config/ci.js';
import { createGh } from '../../../gh-exec.js';
import {
  confirmStoryMerged as defaultConfirmStoryMerged,
  readPrMergeState as defaultReadPrMergeState,
} from '../../../single-story/confirm-merge.js';
import { pollUntil } from '../../../util/poll-loop.js';
import { applyBehindUpdate } from '../../behind-recovery.js';
import {
  emitMergeFlipFailed as defaultEmitMergeFlipFailed,
  MERGED_FLIP_FAILED_BLOCK_CLASS,
} from '../../lifecycle/emit-merge-flip-failed.js';
import { emitMergeUnlanded as defaultEmitMergeUnlanded } from '../../lifecycle/emit-merge-unlanded.js';
import { classifyMergeBlock as defaultClassifyMergeBlock } from '../../merge-block-class.js';
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_BUDGET_SECONDS,
  decideAdvisoryGateBlock,
  decideMergeWaitFailFast,
  deriveChecksStatus,
  deriveRedHeadRuns,
  deriveRequiredRunEvidence,
  MERGE_WAIT_GH_TIMEOUT_MS,
  parseWorkflowRunId,
  readRunSummary,
  resolveAdvisoryGateVerdict,
} from '../../merge-poll.js';
import { NEXT_COMMANDS } from '../../story-deliver-terminal.js';
import {
  postStructuredComment,
  STATE_LABELS,
  transitionTicketState,
} from '../../ticketing.js';
import { disarmAutoMerge } from './auto-merge.js';
import { runPostLandTail as defaultRunPostLandTail } from './post-land.js';

/**
 * Per-invocation merge-wait bound. 300s fits inside a single host tool
 * invocation (~10 min ceiling) with room for the close gates that precede
 * the wait. A headless caller with no such ceiling raises
 * `delivery.mergeWatch.maxWaitSeconds` to keep single-block semantics.
 */
export const DEFAULT_MAX_WAIT_SECONDS = 300;

/**
 * Async-mode per-invocation probe window (Story #4698). When
 * `delivery.mergeWatch.mode` is `"async"`, `resolveMergeWaitConfig` caps the
 * per-invocation wait to this many seconds so close returns the resumable
 * `pending` terminal fast instead of burning the foreground host slot. Sized
 * to catch an instant merge and — via the head-anchored required-check
 * predicate — an instantly-red required check, while staying far inside the
 * cumulative `maxBudgetSeconds` give-up bound.
 */
export const ASYNC_PROBE_WINDOW_SECONDS = 60;

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
 * The wait's default `gh` facade, bound to a spawn-level timeout (Story
 * #4710): every subprocess the wait launches through it carries
 * `MERGE_WAIT_GH_TIMEOUT_MS`, so a wedged `gh` child is killed rather than
 * stranding an unattended async-mode wait forever. Callers that inject their
 * own `gh` (tests, the resume CLI) are bounded by {@link withGhTimeout} at
 * the call sites instead.
 */
const defaultGh = createGh(undefined, { timeoutMs: MERGE_WAIT_GH_TIMEOUT_MS });

/**
 * Bound an arbitrary `gh` call with a wall-clock timeout (Story #4710). The
 * spawn-level `timeoutMs` on {@link defaultGh} already kills a wedged real
 * subprocess, but an injected `gh` implementation (a test stub, a facade
 * built without defaults) can still return a promise that never settles —
 * and the merge wait must never hang on any of them. Rejection maps to the
 * caller's existing error handling: the probe degrades to its conservative
 * pending shape, the update-branch attempt logs and continues.
 *
 * A late settlement of the losing promise is explicitly absorbed so a
 * post-timeout rejection cannot surface as an unhandled rejection.
 *
 * The timeout timer is deliberately NOT `unref`'d: when the awaited call is a
 * promise that never settles (a hung stub, or a real gh child whose I/O has
 * gone quiet), the timer is the ONLY handle keeping the event loop alive, so
 * unref'ing it would let the process/test exit before the timeout ever fires —
 * exactly the hang this guard exists to prevent. It is short-lived and always
 * cleared in `finally`, so keeping it referenced costs nothing.
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
 * One string field off a `gh pr view` payload, or `absent` when the API did
 * not return one. Deduplicated out of the probe below (Story #5266): six
 * identical `typeof x === 'string'` ternaries put that one function over the
 * CRAP ratchet the moment a seventh field was needed.
 *
 * An empty string counts as absent — `gh` returns `""` for a field it cannot
 * read, and every caller treats that exactly as "not there".
 *
 * @param {unknown} value
 * @param {null|undefined} [absent] What to report when the field is missing.
 *   `null` for the three fields the poll loop compares against null; the
 *   `undefined` default for the ones whose absence must not shadow a
 *   downstream default.
 * @returns {string|null|undefined}
 */
function readString(value, absent = undefined) {
  return typeof value === 'string' && value ? value : absent;
}

/**
 * One probe per poll iteration, carrying every field the loop and the
 * terminal classifier need: merge state, the checks rollup, the merge-state
 * status (for BEHIND recovery and human-required classification), and
 * `createdAt` (the cumulative-budget anchor).
 *
 * Returns a degraded `{ checksStatus: 'pending', error }` probe when the read
 * itself fails, preserving the conservative classification on probe errors —
 * a flaky API read must not be mistaken for a definitive verdict. A probe
 * that exceeds `ghTimeoutMs` (Story #4710) takes the SAME degraded path: a
 * hung subprocess must surface as a probe error within the bound, never
 * strand the wait.
 *
 * @returns {Promise<object>}
 */
export async function readPrWaitProbe({
  prNumber,
  gh = defaultGh,
  ghTimeoutMs = MERGE_WAIT_GH_TIMEOUT_MS,
}) {
  try {
    const view = await withGhTimeout(
      gh.pr.view(prNumber, [
        'state',
        'mergedAt',
        'createdAt',
        'mergeStateStatus',
        'reviewDecision',
        'statusCheckRollup',
        // Story #5266 — the head the red advisory runs belong to, so their
        // check-run output can be read back and classified.
        'headRefOid',
      ]),
      ghTimeoutMs,
      `gh pr view ${prNumber}`,
    );
    return {
      state: readString(view?.state, null),
      mergedAt: readString(view?.mergedAt, null),
      createdAt: readString(view?.createdAt, null),
      mergeStateStatus: readString(view?.mergeStateStatus),
      reviewDecision: readString(view?.reviewDecision),
      checksStatus: deriveChecksStatus(view?.statusCheckRollup),
      // Head-anchored per-run evidence (Story #4695): distinguishes a
      // genuinely red required run from the superseded / still-pending noise
      // the aggregate `checksStatus` folds together. `null` when the rollup is
      // absent/empty — the loop's consecutive-probe fallback owns that path.
      requiredRunEvidence: deriveRequiredRunEvidence(view?.statusCheckRollup),
      // The named red head runs (Story #5096), so an `advisory-gate-red`
      // verdict can name the offending job and match the allowlist. Same
      // red-ness test as `requiredRunEvidence`, so the two cannot disagree.
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
 * Resolve the wait cadence and both budgets from `delivery.mergeWatch.*`,
 * falling back to the framework defaults when a key is absent or invalid.
 *
 * `maxWaitSecondsOverride` is the per-run `--max-wait-seconds` flag and wins
 * over the config: a headless caller with no host tool-invocation ceiling
 * raises the per-invocation bound to keep single-block semantics without
 * editing the consumer's config.
 *
 * `mode` (Story #4698) selects the close-time merge posture. `async` caps the
 * per-invocation wait to `ASYNC_PROBE_WINDOW_SECONDS` so close returns the
 * resumable `pending` terminal fast; `sync` (the default) is unchanged. An
 * explicit `maxWaitSecondsOverride` still wins over the async cap — a headless
 * caller with no host ceiling opts back into single-block waiting.
 *
 * `modeOverride` is the per-invocation `--merge-watch-mode` flag (Story #4949)
 * and wins over `delivery.mergeWatch.mode` on exactly the precedence
 * `maxWaitSecondsOverride` already uses. It exists because run topology is
 * knowable only to the orchestrator: close sees one Story and cannot tell a
 * solo delivery (where a foreground wait is the cheapest ending) from the Nth
 * close of a wave (where each foreground wait is serialized dead time). The
 * config default therefore stays `sync`, and the caller that knows better says
 * so per invocation. The two flags remain composable — `--merge-watch-mode
 * async --max-wait-seconds 900` selects the async posture and then overrides
 * its probe cap, because the cap check below keys on the override's presence,
 * not on where the mode came from.
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
  const int = (value, fallback, min = 1) =>
    Number.isInteger(value) && value >= min ? value : fallback;
  const requestedMode = modeOverride ?? mergeWatch.mode;
  const mode = requestedMode === 'async' ? 'async' : 'sync';
  const configuredMaxWait = int(
    maxWaitSecondsOverride,
    int(mergeWatch.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS),
  );
  // Async mode caps the per-invocation wait to a short probe window so close
  // returns `pending` fast instead of burning the foreground host slot on a
  // merge that lands after the wait would have expired anyway. The window is
  // long enough for the loop's existing checks to catch an instant merge and —
  // via the imported `decideMergeWaitFailFast` decision — an instantly
  // red required check. An explicit `--max-wait-seconds` override still wins so
  // a headless caller with no host ceiling opts back into single-block waiting.
  const maxWaitSeconds =
    mode === 'async' && maxWaitSecondsOverride == null
      ? Math.min(configuredMaxWait, ASYNC_PROBE_WINDOW_SECONDS)
      : configuredMaxWait;
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
    mode,
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
        `the red disarms auto-merge, and only a green on a new head SHA re-arms it — ` +
        `re-running the failed job is forbidden. Watch the checks with:\n\n` +
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
/**
 * Story #5096 — resolve the advisory-gate terminal for one poll.
 *
 * Takes the poll's current `unlanded` and returns it unchanged when a terminal
 * is already decided, so the caller is a single assignment with NO added
 * branch. `runMergePoll` is already above `check-cyclomatic`'s ceiling; the
 * three decision points this would otherwise cost inline are a real gate
 * regression, and they belong with the policy either way.
 *
 * Disarms BEFORE returning the terminal: an armed PR can merge out from under
 * the block the caller is about to record.
 */
/**
 * Story #5266 — the per-invocation advisory rerun allowance.
 *
 * `--rerun-advisory <n>` wins over `delivery.ci.rerunAdvisory` on exactly the
 * precedence `--max-wait-seconds` already uses. Both default to **0**: a
 * rerun spends CI minutes and mutates GitHub state, so close does neither
 * unasked. A non-integer or negative override is not an instruction to guess
 * — it degrades to the config value.
 *
 * @param {object|null} config Resolved config (or any `delivery.ci` bag).
 * @param {number} [override] The `--rerun-advisory` value, when supplied.
 * @returns {number} allowance ≥ 0
 */
export function resolveAdvisoryRerunAllowance(config, override) {
  if (Number.isInteger(override) && override >= 0) return override;
  return getCiDelivery(config).rerunAdvisory;
}

/**
 * Identify ONE observation of a red run: the job, the workflow run behind it,
 * and when that run finished. A rerun changes `completedAt` (and eventually
 * the conclusion), so this is what lets the wait tell a re-run's verdict apart
 * from the stale pre-rerun snapshot it will keep seeing for a poll or two.
 *
 * @param {{name?: string|null, runId?: number, completedAt?: string}} run
 * @returns {string}
 */
function advisoryRunSignature(run) {
  return `${run?.name ?? '(unnamed)'}@${run?.runId ?? 'no-run'}#${run?.completedAt ?? 'no-stamp'}`;
}

/**
 * Story #5266 — read each red advisory run's own account of WHY it failed.
 *
 * `gh pr view --json statusCheckRollup` has a fixed projection that carries no
 * output text for a CheckRun, so on the rollup alone every red advisory run
 * looks identical — which is the defect. The check-runs API for the head SHA
 * carries `output.title` / `output.summary`, and ONE call for the whole head
 * is enough to classify every red run on it.
 *
 * Called only on the block path (never per poll), and **fails open**: any
 * error, timeout, or missing head SHA returns the runs unchanged, which
 * classifies them as `advisory-gate-red` — the pre-#5266 verdict.
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
 * Story #5266 — re-run the failed advisory workflow run(s), once, within the
 * caller's remaining allowance.
 *
 * Requests `rerun-failed-jobs` per distinct workflow run rather than per job:
 * one advisory workflow commonly fans out, and re-running the whole failed set
 * is both cheaper in API calls and what an operator means by "re-run it".
 *
 * @returns {Promise<boolean>} whether every rerun request succeeded. `false`
 *   (including "no run id to re-run") leaves the caller on the block path,
 *   because an allowance that cannot be spent must not silently suppress the
 *   gate.
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
 * Spend one unit of the rerun allowance, if there is one and the rerun takes.
 * Records the observation signature of every run it re-ran, so the stale
 * pre-rerun snapshot the next poll reads does not re-block on the same job.
 *
 * Deliberately does NOT disarm first, unlike the block path: the whole point
 * of a rerun is that a green re-run lands the PR on its own. The cost is an
 * armed window in which GitHub could land the PR over the still-red advisory
 * if the required contexts go green before the re-run reports — which is
 * exactly what opting in to `--rerun-advisory` buys and accepts. At the
 * default 0 there is no such window.
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
  if (rerunState.remaining <= 0) return false;
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
  // Every blocking run is one this invocation already re-ran and has not seen
  // a fresh verdict for yet (Story #5266) — keep polling rather than blocking
  // on the snapshot the rerun was meant to replace.
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
}) {
  // Story #5096 — `advisory-gate-red` is emitted DIRECTLY, never derived.
  // `classifyMergeBlock` cannot produce it: by construction GitHub is NOT
  // gating this merge (`mergeStateStatus: UNSTABLE`), which is the entire
  // condition the class names, so every classifier heuristic reads the PR as
  // healthy.
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
  // Which evidence path produced a `checks-failed` verdict (Story #4695):
  // `per-run` (head-anchored required-run evidence) or `consecutive-probe`
  // (the evidence-unavailable fallback). Named on the emitted record so the
  // `merge.unlanded` telemetry attributes the fail-fast to the path that
  // fired it. Absent for every other block class.
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
 * real state and lets the normal classification decide, which is why a
 * failed attempt still counts against the wait's tick.
 *
 * The BEHIND / budget / did-it-land decision itself lives in the shared
 * {@link applyBehindUpdate} (Story #5006) — the CI-watch loop in
 * `lib/orchestration/pr-watch.js` runs the same one. This wrapper supplies
 * the merge wait's probe source, its `gh` facade (bounded by
 * {@link withGhTimeout}, so a wedged child cannot strand an unattended
 * async-mode wait), and its operator wording.
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
 * @param {'sync'|'async'} [args.mergeWatchMode] Per-invocation
 *   `--merge-watch-mode` override (Story #4949); wins over
 *   `delivery.mergeWatch.mode`.
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @param {number} [args.rerunAdvisory] `--rerun-advisory <n>` — the
 *   per-invocation override of `delivery.ci.rerunAdvisory` (both default 0).
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
 * @param {number} [args.ghTimeoutMs] Wall-clock bound for each `gh` call the
 *   wait makes (Story #4710). A framework constant
 *   (`MERGE_WAIT_GH_TIMEOUT_MS`), overridable only as a test seam — not
 *   config.
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
  sleepFn = defaultSleep,
  nowMsFn = Date.now,
  ghTimeoutMs = MERGE_WAIT_GH_TIMEOUT_MS,
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
      // Story #5096 — the arm phase already refused over a red advisory gate;
      // carry its verdict through instead of letting the classifier read this
      // as a generic `arm-failure`.
      // Story #5266 — carry the arm phase's CLASS too: a pre-arm refusal over
      // a scan that never finished is `advisory-gate-inconclusive`, and
      // hard-coding the red class here would relabel it at the terminal.
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
  // Story #5096 — the advisory-gate knobs, read once for the whole wait.
  const { blockOnAdvisoryFailure, advisoryAllowlist } = getCiDelivery(config);
  // Story #5266 — the rerun allowance and its ledger, spent across the whole
  // wait rather than per poll, so `n` bounds the CI minutes this invocation
  // can cost no matter how many times the gate is observed red.
  const rerunAllowance = resolveAdvisoryRerunAllowance(
    config,
    rerunAdvisoryOverride,
  );
  const rerunState = {
    allowance: rerunAllowance,
    remaining: rerunAllowance,
    issued: new Set(),
  };
  const intervalMs = intervalSeconds * 1000;
  const startedAtMs = nowMsFn();
  let anchorMs = startedAtMs;
  let updatesUsed = 0;
  let polls = 0;
  // Consecutive failing check probes observed WITHOUT per-run evidence
  // (Story #4695). The evidence-unavailable fallback: a single failing rollup
  // snapshot never fail-fasts — two consecutive failing probes at least one
  // poll interval apart are required. Reset on any non-failing (or genuinely
  // evidenced) probe.
  let consecutiveRequiredFailSnapshots = 0;

  progress?.(
    'CONFIRM',
    `⏳ Close-and-land: polling PR #${prNumber} for merge confirmation ` +
      `(mode=${mode}, wait=${maxWaitSeconds}s this invocation, ` +
      `cumulative budget=${maxBudgetSeconds}s)...`,
  );

  /**
   * One poll iteration. Returns `{ done: false }` to keep polling, or
   * `{ done: true, outcome }` with the phase's terminal. Story #4873 lifted
   * this body out of a bespoke unbounded loop so the cadence is owned by the
   * shared {@link pollUntil} primitive — the loop below sleeps, aborts, and
   * counts ticks in exactly one place for every wait in the codebase. Every
   * budget, floor, and classification decision is unchanged; only who owns the
   * `await sleep(...)` moved.
   *
   * A throw from any of the terminal handlers is captured rather than allowed
   * to escape into `pollUntil` (which treats a throwing `fn` as a non-match
   * and would spin forever on it); the caller re-throws it after the loop.
   */
  async function runMergePoll() {
    const probe = await readPrWaitProbeFn({
      prNumber,
      gh: injectedGh,
      ghTimeoutMs,
    });
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

    // Heartbeat (Story #4873). A backgrounded close writes this phase's
    // progress to its own output file, and between the opening banner and the
    // terminal there used to be NOTHING for minutes at a time — so an
    // orchestrator watching that file could not tell a healthy in-flight wait
    // from a wedged process without going back to GitHub itself. One line per
    // poll makes the file's own growth the liveness signal.
    progress?.(
      'CONFIRM',
      `⏱  poll ${polls}: PR #${prNumber} state=${probe.state ?? 'unknown'} ` +
        `checks=${probe.checksStatus ?? 'unknown'} ` +
        `mergeState=${probe.mergeStateStatus ?? 'unknown'} ` +
        `(${waitBudget.waitedSeconds}s of ${maxWaitSeconds}s this invocation; ` +
        `${waitBudget.cumulativeSeconds}s of ${maxBudgetSeconds}s cumulative)` +
        (probe.error ? ` — probe error: ${probe.error}` : ''),
    );

    if (probe.state === 'MERGED' || probe.mergedAt) {
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

    // Everything below funnels into ONE terminal exit (Story #4710): each
    // definitive condition fills `unlanded` and the single call site at the
    // bottom classifies, emits, and blocks — the fail-fast tree used to
    // duplicate that block twice inline.
    let unlanded = null;

    if (probe.state === 'CLOSED') {
      // Closed without merging — a definitive terminal, not a "still
      // pending" condition the budget should keep waiting on. checksStatus
      // MUST be a non-pending, non-undefined value here: the classifier's
      // budget-exhausted branch treats an undefined checksStatus as "still
      // pending", which would misclassify this definitive case as
      // checks-pending-timeout instead of reaching the api-race-other
      // reason built from prProbe.error.
      unlanded = {
        prProbe: {
          checksStatus: 'closed',
          error: 'PR closed without merging (state=CLOSED)',
        },
        budget: {
          exhausted: true,
          elapsedSeconds: Math.round(waitedMs / 1000),
        },
      };
    } else {
      // Fail fast on a GENUINELY red REQUIRED check — head-anchored (Story
      // #4695), decided by the extracted `decideMergeWaitFailFast` (Story
      // #4710): per-run evidence decides on a single probe; without evidence
      // two consecutive failing probes are required. No remaining budget
      // turns a failed check green, and waiting it out is what made the
      // pre-#4543 wait report the operator's red test run as a
      // branch-protection block.
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
        };
      }

      // Story #5096 — the ADVISORY counterpart, and the half that catches the
      // common shape. Close arms immediately after opening the PR, while the
      // gate is still QUEUED, so the pre-arm refusal in `auto-merge.js` sees
      // nothing; the gate reddens here, mid-wait, and native auto-merge would
      // land the PR the moment the REQUIRED contexts go green.
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

      // Cumulative budget exhausted → the genuine give-up. Classify from the
      // probe we already hold. Gated behind the poll floor so an
      // already-over-budget PR (anchored at a createdAt older than the budget
      // — a resume the next day, or a long-open PR) still gets a real poll
      // cycle instead of being blocked before this invocation waited at all.
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
        // A terminal handler threw. `pollUntil` treats a throwing `fn` as a
        // non-match and would poll forever on it, so the throw is carried out
        // as a match and re-raised below.
        return { done: true, thrown: err };
      }
    },
    predicate: (result) => result?.done === true,
    intervalMs,
    // The wait owns its own bounds (`maxWaitSeconds` → `pending`,
    // `maxBudgetSeconds` → blocked), and both are decided from the probe
    // inside the tick. A second, cruder wall-clock timeout here would throw
    // past those classifications.
    sleepFn: (ms) => sleepFn(ms),
  });
  if (tick.thrown) throw tick.thrown;
  return tick.outcome;
}

/** Wrap a phase terminal as the poll loop's match. */
function doneWith(outcome) {
  return { done: true, outcome };
}
