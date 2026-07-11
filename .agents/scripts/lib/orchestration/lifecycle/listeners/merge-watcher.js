// .agents/scripts/lib/orchestration/lifecycle/listeners/merge-watcher.js
/**
 * MergeWatcher — lifecycle listener that polls GitHub for merge
 * confirmation of an Epic PR and emits `epic.merge.confirmed`. Story
 * #2896 / Task #2907 (Epic #2880).
 *
 * Subscribes to:
 *   - `epic.merge.armed` → and ONLY this event.
 *
 * Side effects executed inside `handle()`:
 *   1. Read the per-watcher resume ledger
 *      (`<tempRoot>/epic-<id>/merge-watcher.ndjson`) to determine
 *      the starting attempt number (resume contract — see below).
 *   2. Poll `gh pr view <prUrl> --json mergeCommit,mergedAt` on a
 *      cadence governed by `intervalSeconds`/`maxBudgetSeconds`.
 *      Each attempt is appended to the resume ledger as
 *      `{ attempt, observedAt, status }`.
 *   3. On the first poll where `mergeCommit` is non-null, emit
 *      `epic.merge.confirmed` carrying
 *      `{ epicId, prNumber, mergeCommitSha, mergedAt, pollAttempts }`.
 *   4. If the budget is exceeded without observing a merge, return
 *      a `failed` classification with reason `budget-exceeded` and
 *      do NOT emit `epic.merge.confirmed`. The /deliver
 *      blocker-handler flow surfaces this via `agent::blocked`.
 *
 * Resume contract (AC of Task #2907): the ledger is the source of
 * truth for the next attempt number. If a prior process recorded
 * attempts 1..3 and then crashed, this process starts at attempt 4 —
 * not attempt 1 — so the operator's poll budget is honoured across
 * reruns rather than reset.
 *
 * Idempotency contract (mirrors Cleaner/Armer AC-10): per-instance
 * `Set<string>` of `${event}:${seqId}` keys short-circuits replays
 * within the same process. Cross-process replay protection comes from
 * the on-disk ledger plus the natural idempotency of `gh pr view`
 * (polling an already-merged PR returns `mergeCommit` again, which
 * causes a single `epic.merge.confirmed` emit per `(event, seqId)`).
 *
 * Side-effect firewall: the listener emits on the bus, shells out to
 * `gh`, and appends to its own ledger file. It does NOT mutate ticket
 * labels, post comments, or call `notify`. Downstream listeners
 * (Cleaner / LabelTransitioner on `epic.merge.confirmed`, Task #2912)
 * own those side effects.
 *
 * Must-land terminal step (Story #4427, Epic #4425 slice 2). In
 * headless (`--yes`) delivery runs — signalled via the explicit
 * `headless` constructor option, threaded from `/deliver`'s `--yes`
 * flag through `lifecycle-emit.js`'s `--headless` runtime flag and
 * `buildDefaultListenerChain({ headless })` — budget exhaustion no
 * longer falls straight through to `epic.blocked`. Instead the watcher
 * classifies the block (`classifyMergeBlock`, the shared classifier
 * from Story #4426) and, bounded by one attempt each per watch run:
 *
 *   - `checks-pending-timeout` (required checks still progressing) →
 *     extend the watch budget once and keep polling in the SAME watch
 *     cycle.
 *   - `api-race-other` (no definitive block signal) → re-arm once by
 *     re-emitting `epic.merge.ready` on the bus. This does NOT call
 *     `gh pr merge` directly — AutomergeArmer remains the sole
 *     authorized call site (merge-lockout invariant, Story #4427 AC).
 *     AutomergeArmer's own idempotent `gh pr view` probe short-circuits
 *     to a single `epic.merge.armed` re-emit when auto-merge is
 *     already armed on the PR, which re-triggers this watcher's
 *     `handle()` for a fresh watch cycle that continues the resume
 *     ledger's attempt count.
 *   - `branch-protection-human-required`, or retries already
 *     exhausted (both bounded attempts spent) → terminal: emit
 *     `merge.unlanded` (scope `"epic"`, carrying the block class) via
 *     `emitMergeUnlanded`, THEN fall through to the existing single
 *     `epic.blocked` emit below — one blocked path, never a duplicate
 *     `agent::blocked` transition.
 *
 * Attended-mode (headless === false, the default) behavior is
 * byte-for-byte unchanged: budget exhaustion emits exactly
 * `epic.blocked` with `reason: 'merge-watch:budget-exceeded'`, no
 * classification, no retry, no `merge.unlanded`.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parsePrNumberFromUrl } from '../../../github-url.js';
import { classifyMergeBlock } from '../../merge-block-class.js';
import { emitMergeUnlanded } from '../emit-merge-unlanded.js';

/**
 * Default poll interval and budget. The schema in
 * `.agents/schemas/agentrc.schema.json` exposes these as
 * `delivery.mergeWatch.intervalSeconds` (default 30) and
 * `delivery.mergeWatch.maxBudgetSeconds` (default 3600). Hard-coding
 * the same numbers here makes the listener self-contained when no
 * config is wired in (e.g. unit tests).
 */
export const DEFAULT_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_BUDGET_SECONDS = 3600;

/**
 * Fields requested from `gh pr view` on every poll. The merge-confirm
 * fields (`mergeCommit`, `mergedAt`, `number`) are the original Story
 * #2896 contract; `mergeStateStatus`, `reviewDecision`, and
 * `statusCheckRollup` were added in Story #4427 so a headless
 * budget-exhaustion path can classify the block (`classifyMergeBlock`)
 * from the SAME probe already being polled, instead of issuing a
 * second `gh` call.
 */
const PR_VIEW_JSON_FIELDS =
  'mergeCommit,mergedAt,number,mergeStateStatus,reviewDecision,statusCheckRollup';

/**
 * Default `gh pr view --json <PR_VIEW_JSON_FIELDS>` probe. Pure-spawn
 * helper — exported so tests can stub the shell-out without touching
 * the spawn wrapper.
 */
export function ghPrViewMerge({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'view', prUrl, '--json', PR_VIEW_JSON_FIELDS],
    {
      cwd,
      encoding: 'utf-8',
      shell: false,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Pure: derive an aggregate `checksStatus` (`success` | `pending` |
 * `still-running` | `failure` | `unknown`) from a
 * `statusCheckRollup` array (`gh pr view --json statusCheckRollup`
 * shape: `{ status, conclusion }` per check). Mirrors the values
 * `classifyMergeBlock` expects on `prProbe.checksStatus`.
 */
export function deriveChecksStatus(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return 'unknown';
  }
  let anyPending = false;
  for (const check of statusCheckRollup) {
    const conclusion = String(check?.conclusion ?? '').toUpperCase();
    const status = String(check?.status ?? '').toUpperCase();
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(conclusion)) {
      return 'failure';
    }
    if (status !== 'COMPLETED') {
      anyPending = true;
    }
  }
  return anyPending ? 'still-running' : 'success';
}

/**
 * Parse `gh pr view --json <PR_VIEW_JSON_FIELDS>` output. Returns
 * `{ mergeCommitSha, mergedAt, prNumber, mergeStateStatus,
 * reviewDecision, checksStatus }` where `mergeCommitSha` is `null`
 * until the PR has merged. Pure — exported for tests so the
 * JSON-shape pin is reviewable.
 */
export function parseMergeView(stdout) {
  const empty = {
    mergeCommitSha: null,
    mergedAt: null,
    prNumber: null,
    mergeStateStatus: null,
    reviewDecision: null,
    checksStatus: 'unknown',
  };
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') {
    return empty;
  }
  const merge = parsed.mergeCommit;
  const sha =
    merge && typeof merge === 'object' && typeof merge.oid === 'string'
      ? merge.oid
      : null;
  const mergedAt = typeof parsed.mergedAt === 'string' ? parsed.mergedAt : null;
  const prNumber = Number.isInteger(parsed.number) ? parsed.number : null;
  const mergeStateStatus =
    typeof parsed.mergeStateStatus === 'string'
      ? parsed.mergeStateStatus
      : null;
  const reviewDecision =
    typeof parsed.reviewDecision === 'string' ? parsed.reviewDecision : null;
  const checksStatus = deriveChecksStatus(parsed.statusCheckRollup);
  return {
    mergeCommitSha: sha,
    mergedAt,
    prNumber,
    mergeStateStatus,
    reviewDecision,
    checksStatus,
  };
}

// `parsePrNumberFromUrl` (imported above from the Story #3649 canonical
// `lib/github-url.js` helper) is the last-resort fallback for a `gh pr
// view` probe that never successfully returned `number` (e.g. every poll
// on the final watch cycle probe-failed). `emitMergeUnlanded` requires a
// positive-integer `prNumber`, and `prUrl` is always present by the time
// a watch cycle starts (checked in `handle()`), so this is the
// last-resort source of truth. Re-exported here so existing imports of
// `parsePrNumberFromUrl` from this module (e.g.
// `tests/epic-must-land-terminal.test.js`) keep working without a
// duplicate implementation (code-review finding, Epic #4425).
export { parsePrNumberFromUrl };

/**
 * Resolve the resume-ledger path for an Epic. Pure helper — exported
 * so tests can pin the layout.
 */
export function resolveLedgerPath({ tempRoot, epicId }) {
  return path.join(tempRoot, `epic-${epicId}`, 'merge-watcher.ndjson');
}

/**
 * Read the resume ledger and return the count of already-recorded
 * attempts. A missing file is the typical first-run case → 0. Lines
 * that fail to parse are skipped (defense against truncated writes).
 */
export function readPriorAttempts({
  tempRoot,
  epicId,
  readFileFn = readFileSync,
  existsFn = existsSync,
}) {
  const file = resolveLedgerPath({ tempRoot, epicId });
  if (!existsFn(file)) return 0;
  let raw;
  try {
    raw = readFileFn(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  if (!raw) return 0;
  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && Number.isInteger(record.attempt)) count += 1;
    } catch {
      // Skip malformed lines silently — the count is advisory.
    }
  }
  return count;
}

/**
 * Append a single attempt record to the resume ledger. Creates the
 * directory lazily.
 */
export function appendAttempt({
  tempRoot,
  epicId,
  record,
  appendFn = appendFileSync,
  mkdirFn = mkdirSync,
}) {
  const file = resolveLedgerPath({ tempRoot, epicId });
  mkdirFn(path.dirname(file), { recursive: true });
  appendFn(file, `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * Sleep helper — exported so tests can stub timing without
 * mocking the global.
 */
export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MergeWatcher listener.
 */
export class MergeWatcher {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {number} opts.epicId
   * @param {string} opts.tempRoot
   * @param {string} [opts.cwd]
   * @param {number} [opts.intervalSeconds] Defaults to 30.
   * @param {number} [opts.maxBudgetSeconds] Defaults to 3600.
   * @param {Function} [opts.ghPrViewMergeFn] override for tests.
   * @param {Function} [opts.readPriorAttemptsFn] override for tests.
   * @param {Function} [opts.appendAttemptFn] override for tests.
   * @param {(ms: number) => Promise<void>} [opts.sleepFn] override
   *   for tests so the suite does not actually wait.
   * @param {() => number} [opts.nowMsFn] override for tests; returns
   *   epoch ms.
   * @param {() => string} [opts.nowIsoFn] override for tests; returns
   *   ISO-8601 wall-clock for the attempt record.
   * @param {boolean} [opts.headless] Explicit must-land signal (Story
   *   #4427). Defaults to `false` — attended-mode behavior (immediate
   *   `epic.blocked` on budget exhaustion, no classification, no
   *   retry) is unchanged. `true` engages the bounded classify-and-
   *   retry terminal step. Threaded from `/deliver`'s `--yes` flag via
   *   `lifecycle-emit.js --headless true` → `buildDefaultListenerChain`
   *   — an explicit constructor input, never an ambient global.
   * @param {Function} [opts.emitMergeUnlandedFn] override for tests
   *   (defaults to the real `emitMergeUnlanded`, which appends to the
   *   on-disk lifecycle ledger).
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError('MergeWatcher requires a bus with on() and emit()');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('MergeWatcher requires a numeric epicId');
    }
    if (typeof opts.tempRoot !== 'string' || opts.tempRoot.length === 0) {
      throw new TypeError('MergeWatcher requires a non-empty tempRoot string');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.tempRoot = opts.tempRoot;
    this.cwd = opts.cwd ?? process.cwd();
    this.intervalSeconds =
      Number.isInteger(opts.intervalSeconds) && opts.intervalSeconds >= 1
        ? opts.intervalSeconds
        : DEFAULT_INTERVAL_SECONDS;
    this.maxBudgetSeconds =
      Number.isInteger(opts.maxBudgetSeconds) && opts.maxBudgetSeconds >= 1
        ? opts.maxBudgetSeconds
        : DEFAULT_MAX_BUDGET_SECONDS;
    this.ghPrViewMergeFn = opts.ghPrViewMergeFn ?? ghPrViewMerge;
    this.readPriorAttemptsFn = opts.readPriorAttemptsFn ?? readPriorAttempts;
    this.appendAttemptFn = opts.appendAttemptFn ?? appendAttempt;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.nowIsoFn =
      opts.nowIsoFn ?? (() => new Date(this.nowMsFn()).toISOString());
    this.headless = opts.headless === true;
    this.emitMergeUnlandedFn = opts.emitMergeUnlandedFn ?? emitMergeUnlanded;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Must-land bounded-retry state (Story #4427, headless only). Each
     * flips to `true` on its single use across the instance's whole
     * lifetime — NOT per watch cycle — so a re-armed or budget-extended
     * cycle that times out again falls straight through to the
     * `merge.unlanded` terminal rather than retrying indefinitely.
     */
    this._budgetExtended = false;
    this._reArmed = false;
    /**
     * Classification log — every `epic.merge.armed` observed lands
     * here with the outcome (`confirmed`, `budget-exceeded`,
     * `skipped-duplicate`, `failed`, or — headless only — `extended` /
     * `re-armed`). Mirrors the Armer / Cleaner "no silent skip"
     * surface.
     */
    this.classifications = [];
    // Frozen tuple — MergeWatcher subscribes to EXACTLY one event.
    // Mirrors the AutomergeArmer single-event contract; the
    // lifecycle-doc-drift check (F5) walks this array.
    this.events = Object.freeze(['epic.merge.armed']);
  }

  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(`[MergeWatcher] skip duplicate ${key} (idempotent)`);
      return;
    }
    this._seen.add(key);

    const prUrl = payload?.prUrl;
    if (typeof prUrl !== 'string' || prUrl.length === 0) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: 'no-pr-url',
      });
      return;
    }

    // Resume contract: read prior attempts from the ledger so this
    // run continues counting from N+1 rather than restarting at 1.
    let priorAttempts;
    try {
      priorAttempts = this.readPriorAttemptsFn({
        tempRoot: this.tempRoot,
        epicId: this.epicId,
      });
    } catch (err) {
      this.logger.warn?.(
        `[MergeWatcher] failed to read resume ledger (degrading to attempt=1): ${err?.message ?? err}`,
      );
      priorAttempts = 0;
    }

    const intervalMs = this.intervalSeconds * 1000;
    // `let`, not `const`: the headless must-land path extends this
    // once on a `checks-pending-timeout` classification (Story #4427).
    let budgetMs = this.maxBudgetSeconds * 1000;
    const startedAtMs = this.nowMsFn();
    let attempt = priorAttempts;

    // Poll loop. Each iteration: increment attempt, call gh,
    // append to ledger, decide. Cadence: a fixed
    // `intervalSeconds` sleep BETWEEN attempts; the first poll
    // fires immediately so a freshly-armed-then-instantly-merged
    // PR confirms without an interval delay.
    //
    // Budget accounting: a poll is allowed iff
    // `now() - startedAtMs <= budgetMs`. Once the budget is
    // exhausted the loop bails with `budget-exceeded`.
    while (true) {
      attempt += 1;
      let probe;
      try {
        probe = this.ghPrViewMergeFn({ prUrl, cwd: this.cwd });
      } catch (err) {
        probe = {
          status: 1,
          stdout: '',
          stderr: err?.message ?? String(err),
        };
      }
      const observedAt = this.nowIsoFn();
      const view = parseMergeView(probe.stdout);
      const status =
        probe.status === 0
          ? view.mergeCommitSha
            ? 'merged'
            : 'pending'
          : 'probe-failed';

      // Persist the attempt BEFORE deciding next steps so a crash
      // here leaves a recoverable trail.
      try {
        this.appendAttemptFn({
          tempRoot: this.tempRoot,
          epicId: this.epicId,
          record: { attempt, observedAt, status },
        });
      } catch (err) {
        this.logger.warn?.(
          `[MergeWatcher] failed to append attempt ${attempt} ledger record (continuing): ${err?.message ?? err}`,
        );
      }

      if (status === 'merged') {
        const confirmPayload = {
          epicId: this.epicId,
          prUrl,
          prNumber: view.prNumber,
          mergeCommitSha: view.mergeCommitSha,
          mergedAt: view.mergedAt,
          pollAttempts: attempt,
        };
        try {
          await this.bus.emit('epic.merge.confirmed', confirmPayload);
        } catch (err) {
          this.classifications.push({
            event,
            seqId,
            outcome: 'failed',
            reason: `confirm-emit-failed:${err?.message ?? err}`,
          });
          this.logger.warn?.(
            `[MergeWatcher] epic.merge.confirmed emit failed: ${err?.message ?? err}`,
          );
          return;
        }
        this.classifications.push({
          event,
          seqId,
          outcome: 'confirmed',
          prUrl,
          pollAttempts: attempt,
          mergeCommitSha: view.mergeCommitSha,
        });
        return;
      }

      // Not merged. Budget check before sleeping.
      const elapsedMs = this.nowMsFn() - startedAtMs;
      if (elapsedMs + intervalMs > budgetMs) {
        // Headless must-land: classify the block and try the bounded
        // per-instance retry (budget extension OR re-arm, each at most
        // once across this watcher's whole lifetime) before giving up.
        // Attended mode (this.headless === false) skips straight to the
        // unchanged budget-exceeded → epic.blocked path below.
        if (this.headless) {
          const elapsedSeconds = Math.floor(elapsedMs / 1000);
          const classification = classifyMergeBlock({
            prProbe: {
              reviewDecision: view.reviewDecision,
              mergeStateStatus: view.mergeStateStatus,
              checksStatus: view.checksStatus,
              error:
                probe.status !== 0
                  ? probe.stderr || 'gh pr view failed'
                  : undefined,
            },
            budget: { exhausted: true, elapsedSeconds },
          });

          if (
            classification.blockClass === 'checks-pending-timeout' &&
            !this._budgetExtended
          ) {
            this._budgetExtended = true;
            budgetMs += this.maxBudgetSeconds * 1000;
            this.classifications.push({
              event,
              seqId,
              outcome: 'extended',
              reason: classification.reason,
              prUrl,
              pollAttempts: attempt,
            });
            this.logger.info?.(
              `[MergeWatcher] extending watch budget once (checks-pending-timeout): ${classification.reason}`,
            );
            await this.sleepFn(intervalMs);
            continue;
          }

          if (
            classification.blockClass === 'api-race-other' &&
            !this._reArmed
          ) {
            this._reArmed = true;
            this.classifications.push({
              event,
              seqId,
              outcome: 're-armed',
              reason: classification.reason,
              prUrl,
              pollAttempts: attempt,
            });
            this.logger.info?.(
              `[MergeWatcher] re-arming once (api-race-other): ${classification.reason}`,
            );
            let reArmEmitSucceeded = false;
            try {
              await this.bus.emit('epic.merge.ready', {
                prUrl,
                reason: `must-land retry: ${classification.reason}`,
              });
              reArmEmitSucceeded = true;
            } catch (err) {
              this.logger.warn?.(
                `[MergeWatcher] must-land re-arm epic.merge.ready emit failed: ${err?.message ?? err}`,
              );
            }
            if (reArmEmitSucceeded) {
              // A successful re-arm re-emits epic.merge.armed (via
              // AutomergeArmer's idempotent-probe short-circuit or a
              // fresh arm), which re-triggers this watcher's handle()
              // for a new watch cycle continuing the resume ledger's
              // attempt count. Do NOT also emit epic.blocked here.
              return;
            }
            // The re-arm attempt itself failed to emit — the bounded
            // retry is spent with nothing landed. Fall through to the
            // terminal merge.unlanded + epic.blocked path below rather
            // than returning silently (audit-quality Critical finding,
            // Epic #4425): a swallowed re-arm failure must still
            // surface as an explicit block, never a silent stall.
          }

          // Terminal: branch-protection-human-required, or both bounded
          // retries already spent. Emit merge.unlanded before falling
          // through to the existing single epic.blocked emit below —
          // one blocked path, never a duplicate agent::blocked
          // transition.
          try {
            this.emitMergeUnlandedFn({
              scope: 'epic',
              ticketId: this.epicId,
              prNumber: view.prNumber ?? parsePrNumberFromUrl(prUrl),
              blockClass: classification.blockClass,
              reason: classification.reason,
              elapsedSeconds,
            });
          } catch (err) {
            this.logger.warn?.(
              `[MergeWatcher] emitMergeUnlanded failed (swallowed): ${err?.message ?? err}`,
            );
          }
        }

        this.classifications.push({
          event,
          seqId,
          outcome: 'failed',
          reason: 'budget-exceeded',
          prUrl,
          pollAttempts: attempt,
          elapsedMs,
        });
        this.logger.warn?.(
          `[MergeWatcher] poll budget exceeded after ${attempt} attempts (${elapsedMs}ms elapsed, budget=${budgetMs}ms).`,
        );
        // ultrareview bug_010: surface the abandonment via the bus so
        // BlockerHandler / LabelTransitioner / StructuredCommentPoster /
        // NotifyDispatcher escalate the Epic to `agent::blocked` with
        // an operator-visible reason. Without this emit the Epic stalls
        // silently — Cleaner never fires, agent::done never flips, and
        // no operator notification is produced. The epic.blocked payload
        // schema is strict (`additionalProperties: false`), so the
        // elapsed/attempt detail stays in the classification log and
        // warn line above rather than in the bus payload.
        try {
          await this.bus.emit('epic.blocked', {
            reason: `merge-watch:budget-exceeded`,
          });
        } catch (err) {
          this.logger.warn?.(
            `[MergeWatcher] epic.blocked emit on budget exhaustion failed (swallowed): ${err?.message ?? err}`,
          );
        }
        return;
      }

      await this.sleepFn(intervalMs);
    }
  }

  reset() {
    this._seen.clear();
    this._budgetExtended = false;
    this._reArmed = false;
    this.classifications = [];
  }
}
