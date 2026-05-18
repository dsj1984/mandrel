// .agents/scripts/lib/orchestration/lifecycle/listeners/watcher.js
/**
 * Watcher — lifecycle listener that owns the required-check poll loop
 * for an open Epic PR. Story #2256 / Task #2261 (Epic #2172).
 *
 * Subscribes to:
 *   - `pr.created` → resolve the required-check names from GitHub at
 *     runtime via `gh pr checks <pr> --required`, emit
 *     `epic.watch.start` carrying that list, poll until every check
 *     reaches a terminal state (or a per-listener wall-clock deadline
 *     expires), then emit `epic.watch.end` with the outcome map.
 *
 * Critical contract:
 *   - Required-check **names** are resolved from `gh pr checks` at
 *     runtime, NOT from `.agentrc.json.branchProtection.requiredChecks`.
 *     The static config remains for local-validation hints only; the
 *     branch-protection ruleset on GitHub is the source of truth at
 *     watch time. This guards against config drift (a config file that
 *     hasn't been updated after a protection rule changed on GitHub
 *     would otherwise cause the watcher to either skip a required check
 *     or wait for a removed one indefinitely).
 *
 * Idempotency contract (AC-10): per-instance `Set<string>` of
 * `${event}:${seqId}` keys. A repeat `(event, seqId)` short-circuits
 * without re-polling and emits nothing. Combined with the bus-level
 * replay defence, this is sufficient — re-running `/epic-deliver` after
 * a crash will produce a NEW seqId and the listener legitimately
 * re-runs the poll loop (which is itself idempotent: the outcome map
 * always reflects the live GitHub state).
 *
 * Side-effect firewall: the listener emits on the bus and shells out
 * to `gh`. It does NOT mutate ticket labels, post comments, or call
 * `notify` — those listeners receive `epic.watch.end` (via the
 * downstream AutomergePredicate → epic.merge.ready/blocked chain) and
 * own their own side effects.
 */

import { spawnSync } from 'node:child_process';

/**
 * Map `gh pr checks` `state` values to the canonical outcome enum on
 * the `epic.watch.end` schema, with a fourth `'pending'` sentinel for
 * in-flight checks. Pure — exported for tests so the pin is explicit
 * and reviewable.
 *
 * `gh` returns capitalized SCREAMING_SNAKE values (`SUCCESS`,
 * `FAILURE`, `TIMED_OUT`, etc.); the schema enum is lowercase. An
 * empty / queued / in_progress state collapses to `'pending'` so the
 * poll loop can distinguish "still running" from terminal outcomes.
 * `'pending'` is intentionally NOT in the schema enum — `reduceOutcomes`
 * is called only on the live state, and the final emit gates on
 * `allTerminal()` so no `'pending'` ever leaks into `epic.watch.end`.
 * Unknown / non-pending unrecognized values collapse to `'skipped'`
 * so any future GitHub state we haven't enumerated still validates.
 */
export function normalizeCheckState(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  switch (v) {
    case '':
    case 'pending':
    case 'queued':
    case 'in_progress':
    case 'requested':
    case 'waiting':
      return 'pending';
    case 'success':
    case 'completed':
      return 'success';
    case 'failure':
    case 'startup_failure':
      return 'failure';
    case 'neutral':
      return 'neutral';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'action_required':
      return 'action_required';
    case 'stale':
      return 'stale';
    case 'skipped':
      return 'skipped';
    default:
      return 'skipped';
  }
}

/**
 * Parse a PR number out of a PR URL. The bus contract gives us
 * `pr.created.prUrl`; `gh pr checks` accepts either the URL or the
 * number — we pass the URL through verbatim, but the helper still
 * exists for tests asserting we never silently coerce a malformed URL.
 *
 * Returns `null` for anything that doesn't look like a GitHub PR URL.
 */
export function extractPrNumber(prUrl) {
  const m = String(prUrl ?? '').match(
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\b/,
  );
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Default `gh pr checks` spawn. Always invokes with `--required` so the
 * returned set is authoritative for branch-protection gating. The
 * `--json name,state,bucket` projection is stable across `gh` >= 2.30.
 *
 * Exported so tests can stub.
 */
export function ghPrChecks({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    [
      'pr',
      'checks',
      prUrl,
      '--required',
      '--json',
      'name,state,bucket,workflow',
    ],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Default `gh pr view` spawn — probes `mergeStateStatus` so the Watcher
 * can detect the BEHIND condition (PR head is behind its base branch)
 * AFTER every required check is green. Exported so tests can stub.
 */
export function ghPrView({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'view', prUrl, '--json', 'mergeStateStatus'],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Parse the `mergeStateStatus` field out of a `gh pr view --json
 * mergeStateStatus` payload. Returns the empty string for malformed
 * input so callers can treat unknown / unparseable states as "not
 * BEHIND" (the conservative recovery branch). Pure — exported for
 * tests.
 */
export function parseMergeStateStatus(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.mergeStateStatus === 'string'
      ? parsed.mergeStateStatus
      : '';
  } catch {
    return '';
  }
}

/**
 * Default `gh pr update-branch` spawn — invoked by the BEHIND recovery
 * loop to fast-forward the PR head with its base branch. Exported so
 * tests can stub and assert call counts.
 */
export function ghPrUpdateBranch({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn('gh', ['pr', 'update-branch', prUrl], {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Outcomes that count as "this required check did not block the
 * merge". Mirrors `automerge-predicate.NON_FAILING_CHECK_OUTCOMES` so
 * the BEHIND-recovery gate ("are all required checks passing?") uses
 * the same definition as the downstream predicate. Pure — exported
 * for tests.
 */
export const GREEN_CHECK_OUTCOMES = Object.freeze(
  new Set(['success', 'neutral', 'skipped']),
);

/**
 * All outcomes are non-failing. Used as the gate before issuing a
 * `gh pr update-branch` recovery call — a red check is a hard block
 * regardless of mergeStateStatus, so we never auto-recover into a
 * failing PR.
 */
export function allGreen(outcomes) {
  const values = Object.values(outcomes);
  if (values.length === 0) return false;
  for (const v of values) {
    if (!GREEN_CHECK_OUTCOMES.has(v)) return false;
  }
  return true;
}

/**
 * Parse the JSON array produced by `gh pr checks --json name,state,…`.
 * Returns `[]` for any malformed input. Pure — exported for tests.
 *
 * Each entry shape: `{ name, state, bucket, workflow }`. The
 * `bucket` field is `gh`'s terminal classification (`pass`, `fail`,
 * `pending`, `skipping`); we prefer `state` when populated and fall
 * back to `bucket` when not.
 */
export function parseGhPrChecks(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) => e && typeof e === 'object' && typeof e.name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Reduce a list of check entries to the `{ checkName: outcome }` map
 * the `epic.watch.end` schema expects. Pure — exported for tests.
 *
 * When `gh` returns the same `name` more than once (parallel matrix
 * builds, retries), the LAST entry wins. The poll loop calls this on
 * every tick so the final emit reflects the most recent state.
 */
export function reduceOutcomes(entries) {
  const out = {};
  for (const e of entries) {
    const raw = e.state || e.bucket || '';
    out[e.name] = normalizeCheckState(raw);
  }
  return out;
}

/**
 * Terminal-state predicate. Pure — exported for tests so the
 * pending-state list is reviewable as code, not as prose.
 *
 * Only `'pending'` is non-terminal — `normalizeCheckState` already
 * collapses every "still running" GitHub state into that sentinel.
 */
export function allTerminal(outcomes) {
  for (const v of Object.values(outcomes)) {
    if (v === 'pending') return false;
  }
  return true;
}

/**
 * Promote any `'pending'` outcomes to the schema-valid `'timed_out'`
 * sentinel before emit. Pure — exported for tests so the cap-fire
 * behaviour is reviewable. Called only when the poll loop exits via
 * the iteration cap.
 */
export function promotePendingToTimedOut(outcomes) {
  const out = {};
  for (const [k, v] of Object.entries(outcomes)) {
    out[k] = v === 'pending' ? 'timed_out' : v;
  }
  return out;
}

/**
 * Default sleeper. Hoisted so tests can stub without faking timers.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watcher listener.
 */
export class Watcher {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {string} [opts.cwd]
   * @param {number} [opts.pollIntervalMs] default 10_000.
   * @param {number} [opts.maxPolls] safety cap on iterations; default
   *   180 (≈30 min @ 10s).
   * @param {number} [opts.maxUpdates] cap on `gh pr update-branch`
   *   recovery calls per `pr.created` event; default 3. Mirrors the
   *   legacy `pr-watch-with-update` cap so a racing base branch
   *   can't induce an infinite update-branch ping-pong.
   * @param {Function} [opts.ghPrChecksFn] override for tests.
   * @param {Function} [opts.ghPrViewFn] override for tests; resolves
   *   `mergeStateStatus` for the BEHIND-recovery gate.
   * @param {Function} [opts.ghPrUpdateBranchFn] override for tests;
   *   issues the fast-forward update on the PR.
   * @param {Function} [opts.sleepFn] override for tests.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError('Watcher requires a bus with on() and emit()');
    }
    this.bus = opts.bus;
    this.cwd = opts.cwd ?? process.cwd();
    this.pollIntervalMs = Number.isInteger(opts.pollIntervalMs)
      ? opts.pollIntervalMs
      : 10_000;
    this.maxPolls = Number.isInteger(opts.maxPolls) ? opts.maxPolls : 180;
    this.maxUpdates =
      Number.isInteger(opts.maxUpdates) && opts.maxUpdates >= 0
        ? opts.maxUpdates
        : 3;
    this.ghPrChecksFn = opts.ghPrChecksFn ?? ghPrChecks;
    this.ghPrViewFn = opts.ghPrViewFn ?? ghPrView;
    this.ghPrUpdateBranchFn = opts.ghPrUpdateBranchFn ?? ghPrUpdateBranch;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every `pr.created` we observe lands here
     * with the outcome (`watched`, `failed`, `skipped-duplicate`,
     * `timed-out`). Mirrors the Finalizer / Reconciler "no silent skip"
     * surface.
     */
    this.classifications = [];
    this.events = Object.freeze(['pr.created']);
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
      this.logger.debug?.(`[Watcher] skip duplicate ${key} (idempotent)`);
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

    // First probe: resolve the required-check name set at runtime.
    const first = this.ghPrChecksFn({ prUrl, cwd: this.cwd });
    // `gh` exits 8 when checks are still pending; this is expected and
    // does not indicate failure. Any other non-zero status with no
    // parseable JSON body is a genuine failure.
    const firstEntries = parseGhPrChecks(first.stdout);
    if (firstEntries.length === 0 && first.status !== 0 && first.status !== 8) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `gh-checks-failed:status=${first.status}`,
      });
      this.logger.warn?.(
        `[Watcher] gh pr checks failed (status=${first.status}): ${first.stderr}`,
      );
      return;
    }

    const requiredChecks = firstEntries.map((e) => e.name);

    try {
      await this.bus.emit('epic.watch.start', { prUrl, requiredChecks });
    } catch (err) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `start-emit-failed:${err?.message ?? err}`,
      });
      this.logger.warn?.(
        `[Watcher] epic.watch.start emit failed: ${err?.message ?? err}`,
      );
      return;
    }

    // Poll loop. The first probe already produced entries; reduce them
    // for the initial outcome map, then iterate until every required
    // check is terminal or the iteration cap fires. After the checks
    // converge, the BEHIND-recovery loop (legacy pr-watch parity) may
    // re-enter this poll loop AFTER issuing `gh pr update-branch`.
    let outcomes = reduceOutcomes(firstEntries);
    let polls = 0;
    let updatesApplied = 0;
    while (polls < this.maxPolls) {
      while (!allTerminal(outcomes) && polls < this.maxPolls) {
        await this.sleepFn(this.pollIntervalMs);
        polls += 1;
        const probe = this.ghPrChecksFn({ prUrl, cwd: this.cwd });
        const entries = parseGhPrChecks(probe.stdout);
        if (entries.length === 0 && probe.status !== 0 && probe.status !== 8) {
          // Transient `gh` failure — log and continue. The outer
          // iteration cap eventually short-circuits if `gh` is
          // unrecoverably broken.
          this.logger.warn?.(
            `[Watcher] gh pr checks transient failure (status=${probe.status}): ${probe.stderr}`,
          );
          continue;
        }
        outcomes = reduceOutcomes(entries);
      }
      // Checks have either all gone terminal or we hit the iteration
      // cap. BEHIND-recovery (legacy pr-watch parity, Story #2327):
      // when every required check is green AND the PR is BEHIND its
      // base, issue ONE `gh pr update-branch` call and re-poll the
      // checks against the freshly-rebased commit. A red check is a
      // hard block — the predicate stops here regardless of merge
      // state. Bounded by `maxUpdates` so a racing base branch can't
      // ping-pong indefinitely.
      if (!allTerminal(outcomes) || !allGreen(outcomes)) break;
      if (updatesApplied >= this.maxUpdates) break;
      const view = this.ghPrViewFn({ prUrl, cwd: this.cwd });
      if (view.status !== 0) {
        this.logger.warn?.(
          `[Watcher] gh pr view failed (status=${view.status}): ${view.stderr}`,
        );
        break;
      }
      const mergeStateStatus = parseMergeStateStatus(view.stdout);
      if (mergeStateStatus !== 'BEHIND') break;
      const update = this.ghPrUpdateBranchFn({ prUrl, cwd: this.cwd });
      if (update.status !== 0) {
        this.logger.warn?.(
          `[Watcher] gh pr update-branch failed (status=${update.status}): ${update.stderr}`,
        );
        break;
      }
      updatesApplied += 1;
      this.logger.info?.(
        `[Watcher] PR BEHIND base — issued gh pr update-branch (#${updatesApplied}/${this.maxUpdates}); re-polling required checks.`,
      );
      await this.sleepFn(this.pollIntervalMs);
      // After update-branch, the freshly-rebased commit invalidates the
      // previous terminal outcomes. Reset to force the inner poll loop
      // to re-evaluate the new CI cycle.
      outcomes = {};
      for (const name of requiredChecks) outcomes[name] = 'pending';
    }

    const isTerminal = allTerminal(outcomes);
    const outcome = isTerminal ? 'watched' : 'timed-out';
    this.classifications.push({
      event,
      seqId,
      outcome,
      polls,
      updatesApplied,
      requiredChecks: requiredChecks.length,
    });
    // The schema enum forbids `'pending'`; promote any leftover
    // pending entries (cap-fire path) to `'timed_out'` before emit.
    const emitOutcomes = isTerminal
      ? outcomes
      : promotePendingToTimedOut(outcomes);
    try {
      await this.bus.emit('epic.watch.end', {
        prUrl,
        checkOutcomes: emitOutcomes,
      });
    } catch (err) {
      this.logger.warn?.(
        `[Watcher] epic.watch.end emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}

export function createWatcher(opts) {
  return new Watcher(opts);
}
