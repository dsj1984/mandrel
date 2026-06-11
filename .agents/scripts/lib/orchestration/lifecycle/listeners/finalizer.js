// .agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js
/**
 * Finalizer — lifecycle listener that owns the finalize-phase side
 * effects gated on a successful acceptance reconciliation. Story #2253
 * / Task #2254 (Epic #2172); promoted to a fully bus-owned writer in
 * Story #2894 / Task #2917 (Epic #2880).
 *
 * Subscribes to:
 *   - `acceptance.reconcile.ok` → run finalize.
 *   - `acceptance.reconcile.waived` → run finalize. Story #2893 split
 *     the `acceptance::n-a` waiver path out of `.skipped` so the
 *     Finalizer can route waived Epics through to PR creation while
 *     `.skipped` (empty-spec) still terminates without a PR.
 *     `.failed` is already routed to `epic.blocked` via the
 *     AcceptanceReconciler and never reaches the Finalizer.
 *
 * Side effects executed inside `handle()`:
 *   1. Emit `epic.finalize.start`.
 *   2. Auto-graduate non-blocking code-review / audit-results findings
 *      (best-effort; never throws).
 *   3. Idempotency probe — `gh pr list --head epic/<id>` returns any
 *      existing PR URL. If one exists, short-circuit to `pr.created`
 *      + `epic.finalize.end` carrying the existing URL.
 *   4. Otherwise, invoke `runFinalizeFn`. The production default
 *      (`composeBusOwnedFinalize`) chains
 *        a. `openOrLocatePr({ epicId, headBranch, baseBranch })`
 *        b. `closePlanningTickets({ epicId, provider })`
 *        c. `postHandoffComment({ epicId, prNumber, prUrl, provider })`
 *      and returns `{ prNumber, prUrl, planningClose, handoff }`.
 *   5. Emit `pr.created` then `epic.finalize.end`.
 *
 * Why the Finalizer does NOT emit `epic.merge.ready` (Story #3367):
 *   `epic.merge.ready` is the SOLE trigger AutomergeArmer subscribes to,
 *   and AutomergeArmer's `epic.merge.armed` cascades synchronously
 *   through MergeWatcher → Cleaner → BranchCleaner (branch reap). If the
 *   Finalizer emitted `epic.merge.ready` directly, firing `epic.close.end`
 *   would run that entire destructive cascade in one synchronous pass —
 *   arming auto-merge and reaping the `epic/<id>` branch BEFORE the PR is
 *   merged, and BYPASSING the AutomergePredicate disqualification gate
 *   (which only ever fires on `epic.watch.end`). The Finalizer's job ends
 *   at opening the PR (`pr.created` + `epic.finalize.end`). The auto-merge
 *   arm flows ONLY through the gated path: `pr.created` → `Watcher` →
 *   `epic.watch.end` → `AutomergePredicate` → `epic.merge.ready` →
 *   `AutomergeArmer`. AutomergePredicate is the SOLE emitter of
 *   `epic.merge.ready` (merge-gate-ordering invariant).
 *
 * Idempotency contract (AC-10): two-layer defence.
 *   1. Per-instance `Set<string>` of `${event}:${seqId}` keys — bus-
 *      level replays short-circuit.
 *   2. The `gh pr list --head` probe + `openOrLocatePr`'s internal
 *      locate path — both defend against cross-process re-runs
 *      (`/deliver` restarted on the same branch after a crash).
 *
 * Side-effect firewall: the listener emits on the bus, shells out to
 * `gh`/`git` (via the helpers), and upserts the `epic-handoff`
 * structured comment via `postHandoffComment`. It does NOT mutate Epic
 * state labels or call `notify` directly — those listeners receive
 * `pr.created` / `epic.finalize.end` and own their own side effects.
 */

import { spawnSync } from 'node:child_process';
import {
  graduateAuditResults as defaultGraduateAuditResults,
  isAutoFileEnabled as isAuditResultsAutoFileEnabled,
} from '../../../feedback-loop/audit-results-graduator.js';
import { graduateFindings as defaultGraduateFindings } from '../../../feedback-loop/code-review-graduator.js';
import { parsePrNumberFromUrl } from '../../../github-url.js';
import { closePlanningTickets as defaultClosePlanningTickets } from '../../finalize/close-planning-tickets.js';
import { openOrLocatePr as defaultOpenOrLocatePr } from '../../finalize/open-or-locate-pr.js';
import { postHandoffComment as defaultPostHandoffComment } from '../../finalize/post-handoff-comment.js';

/**
 * Build the production default `runFinalizeFn` that composes the three
 * bus-owned finalize helpers. Exported as a factory so the listener can
 * inject the provider (which the default needs but tests inject by
 * supplying their own `runFinalizeFn` outright).
 *
 * Returns `{ prNumber, prUrl, planningClose, handoff }` on success, or
 * `{ blocker: { reason, detail } }` when a step fails with an
 * unrecoverable error that should keep the Epic at `agent::blocked`.
 *
 * @param {{
 *   provider?: object|null,
 *   openOrLocatePrFn?: typeof defaultOpenOrLocatePr,
 *   closePlanningTicketsFn?: typeof defaultClosePlanningTickets,
 *   postHandoffCommentFn?: typeof defaultPostHandoffComment,
 * }} deps
 */
export function composeBusOwnedFinalize(deps = {}) {
  const openOrLocatePrFn = deps.openOrLocatePrFn ?? defaultOpenOrLocatePr;
  const closePlanningTicketsFn =
    deps.closePlanningTicketsFn ?? defaultClosePlanningTickets;
  const postHandoffCommentFn =
    deps.postHandoffCommentFn ?? defaultPostHandoffComment;
  const provider = deps.provider ?? null;

  return async function runBusOwnedFinalize({ epicId, cwd } = {}) {
    if (!Number.isInteger(epicId) || epicId < 1) {
      return {
        blocker: {
          reason: 'invalid-epicId',
          detail: `runFinalizeFn called with invalid epicId ${epicId}`,
        },
      };
    }
    let openResult;
    try {
      openResult = await openOrLocatePrFn({
        epicId,
        headBranch: `epic/${epicId}`,
        baseBranch: 'main',
        cwd,
      });
    } catch (err) {
      return {
        blocker: {
          reason: 'open-or-locate-pr-failed',
          detail: err?.message ?? String(err),
        },
      };
    }
    if (
      !openResult ||
      !Number.isInteger(openResult.prNumber) ||
      typeof openResult.url !== 'string'
    ) {
      return {
        blocker: {
          reason: 'open-or-locate-pr-empty',
          detail: 'openOrLocatePr returned no { prNumber, url } envelope',
        },
      };
    }

    // Planning-ticket close + handoff comment require a provider.
    // The lifecycle-emit CLI may construct the Finalizer without one;
    // in that case both steps short-circuit with a 'skipped' marker
    // (the run itself still succeeds — the PR is open and the bus can
    // arm auto-merge).
    let planningClose = null;
    if (provider) {
      try {
        planningClose = await closePlanningTicketsFn({
          epicId,
          provider,
        });
      } catch (err) {
        return {
          blocker: {
            reason: 'close-planning-tickets-failed',
            detail: err?.message ?? String(err),
          },
        };
      }
    }

    let handoff = null;
    if (provider) {
      try {
        handoff = await postHandoffCommentFn({
          epicId,
          prNumber: openResult.prNumber,
          prUrl: openResult.url,
          provider,
        });
      } catch (err) {
        // Handoff is best-effort — failing to upsert the marker comment
        // should not roll back the PR open. Surface as a non-blocker so
        // the Finalizer still emits pr.created and arms downstream.
        handoff = {
          marker: 'epic-handoff',
          commentId: null,
          error: err?.message ?? String(err),
        };
      }
    }

    return {
      epicId,
      prNumber: openResult.prNumber,
      prUrl: openResult.url,
      created: openResult.created,
      planningClose,
      handoff,
    };
  };
}

/**
 * Parse `gh pr list --head <branch> --json url --jq '.[0].url'` output
 * into a PR URL or null. Pure — exported for tests so the regex pin is
 * explicit and reviewable.
 *
 * Accepted forms:
 *   - `https://github.com/owner/repo/pull/123\n` — typical happy path.
 *   - empty / whitespace                          — no PR open.
 *   - JSON array `[{"url":"…"}]` — when the caller did not pass `--jq`.
 */
export function extractPrUrl(stdout) {
  const trimmed = String(stdout || '').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const url = parsed[0]?.url;
        if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) {
          return url;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  const match = trimmed.match(/^https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  return match ? match[0] : null;
}

/**
 * Default `gh` spawn used by the listener's idempotency probe.
 * Mirrors the `shell: false` contract `openOrLocatePr` and the other
 * listener helpers use so a future Windows audit doesn't have to grep
 * across two modules. Exported so tests can stub.
 */
export function ghPrListHead({ epicBranch, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'list', '--head', epicBranch, '--json', 'url', '--jq', '.[0].url'],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Finalizer listener.
 */
export class Finalizer {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {number} opts.epicId
   * @param {string} [opts.cwd]
   * @param {boolean} [opts.fullScope] forwarded to `runFinalizeFn`;
   *   defaults to false (diff-scope).
   * @param {Function} [opts.runFinalizeFn] override of the composed
   *   bus-owned finalize default; tests inject their own stub.
   * @param {Function} [opts.ghPrListHeadFn] override of the
   *   idempotency probe.
   * @param {object} [opts.provider] Ticketing provider forwarded to
   *   the default `runFinalizeFn` (for `closePlanningTickets` /
   *   `postHandoffComment`) and to the graduators.
   * @param {object} [opts.config] Resolved agent config; forwarded to
   *   the graduators.
   * @param {{owner:string,repo:string}} [opts.currentRepo]
   * @param {{owner:string,repo:string}} [opts.frameworkRepo]
   * @param {Function} [opts.graduateFindingsFn]
   * @param {Function} [opts.graduateAuditResultsFn]
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError('Finalizer requires a bus with on() and emit()');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('Finalizer requires a numeric epicId');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.cwd = opts.cwd ?? process.cwd();
    this.fullScope = opts.fullScope === true;
    this.provider = opts.provider ?? null;
    this.runFinalizeFn =
      opts.runFinalizeFn ??
      composeBusOwnedFinalize({ provider: this.provider });
    this.ghPrListHeadFn = opts.ghPrListHeadFn ?? ghPrListHead;
    // ultrareview bug_007: the existing-PR short-circuit must run the
    // planning-ticket close and the handoff-comment upsert (both
    // idempotent) so crash-recovery replays don't skip them. Stored as
    // instance overrides so tests can swap them with no-op stubs.
    this.closePlanningTicketsFn =
      opts.closePlanningTicketsFn ?? defaultClosePlanningTickets;
    this.postHandoffCommentFn =
      opts.postHandoffCommentFn ?? defaultPostHandoffComment;
    this.config = opts.config ?? null;
    this.currentRepo = opts.currentRepo ?? null;
    this.frameworkRepo = opts.frameworkRepo ?? null;
    this.graduateFindingsFn =
      opts.graduateFindingsFn ?? defaultGraduateFindings;
    this.graduateAuditResultsFn =
      opts.graduateAuditResultsFn ?? defaultGraduateAuditResults;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every `acceptance.reconcile.ok` or `.waived`
     * we observe lands here with the outcome (`opened`, `existing`,
     * `failed`, `skipped-duplicate`). Mirrors the BlockerHandler /
     * Reconciler "no silent skip" surface.
     */
    this.classifications = [];
    this.events = Object.freeze([
      'acceptance.reconcile.ok',
      'acceptance.reconcile.waived',
    ]);
  }

  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload: _payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(`[Finalizer] skip duplicate ${key} (idempotent)`);
      return;
    }
    this._seen.add(key);

    const epicId = this.epicId;
    const epicBranch = `epic/${epicId}`;

    // 1. Announce finalize.start.
    try {
      await this.bus.emit('epic.finalize.start', { epicId });
    } catch (err) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `start-emit-failed:${err?.message ?? err}`,
      });
      this.logger.warn?.(
        `[Finalizer] epic.finalize.start emit failed: ${err?.message ?? err}`,
      );
      return;
    }

    // 1b. Auto-graduate non-blocking code-review findings (Story #2555).
    await this._runCodeReviewGraduation();

    // 1c. Auto-graduate non-blocking audit-results findings (Story #2615).
    await this._runAuditResultsGraduation();

    // 2. Idempotency probe — does a PR already exist on the head
    //    branch? If yes, short-circuit to a pr.created emit with the
    //    existing URL. This is the AC-10 contract for the most-risky
    //    non-trivial idempotency case (cross-process re-run after a
    //    crash between `gh pr create` and `pr.created` emit). The
    //    bus-owned default `runFinalizeFn` also re-checks via
    //    `openOrLocatePr`; the listener-level probe is defence in
    //    depth and keeps the existing test surface stable.
    const probe = this.ghPrListHeadFn({ epicBranch, cwd: this.cwd });
    if (probe.status === 0) {
      const existingUrl = extractPrUrl(probe.stdout);
      if (existingUrl) {
        this.logger.info?.(
          `[Finalizer] PR already open for ${epicBranch}: ${existingUrl} — short-circuiting create.`,
        );
        const prNumber = parsePrNumberFromUrl(existingUrl);
        // ultrareview bug_007: even on the short-circuit path we MUST
        // run the planning-ticket close and the handoff-comment upsert.
        // Both helpers are idempotent — closePlanningTickets counts
        // already-closed tickets under `alreadyClosed`, postHandoffComment
        // edits an existing marker comment in place. Without these calls,
        // a crash-recovery replay against an already-open PR leaves the
        // three planning context tickets open and never posts the
        // handoff comment, even though epic.merge.ready is still emitted.
        try {
          await this.closePlanningTicketsFn({
            epicId: this.epicId,
            provider: this.provider,
            cwd: this.cwd,
          });
        } catch (err) {
          this.logger.warn?.(
            `[Finalizer] closePlanningTickets on short-circuit failed (swallowed; replay will retry): ${err?.message ?? err}`,
          );
        }
        try {
          await this.postHandoffCommentFn({
            epicId: this.epicId,
            prNumber,
            prUrl: existingUrl,
            provider: this.provider,
            cwd: this.cwd,
          });
        } catch (err) {
          this.logger.warn?.(
            `[Finalizer] postHandoffComment on short-circuit failed (swallowed; replay will retry): ${err?.message ?? err}`,
          );
        }
        await this._emitFinalize({
          event,
          seqId,
          prUrl: existingUrl,
          prNumber,
          epicBranch,
          base: this._resolveBase(),
          outcome: 'existing',
        });
        return;
      }
    } else {
      this.logger.warn?.(
        `[Finalizer] gh pr list probe failed (status=${probe.status}): ${probe.stderr} — proceeding with create.`,
      );
    }

    // 3. Run the composed bus-owned finalize (or the test-injected
    //    `runFinalizeFn`). The default chains openOrLocatePr →
    //    closePlanningTickets → postHandoffComment in order and
    //    returns `{ prNumber, prUrl, planningClose, handoff }`.
    let finalize;
    try {
      finalize = await this.runFinalizeFn({
        epicId,
        cwd: this.cwd,
        fullScope: this.fullScope,
        loggerImpl: this.logger,
      });
    } catch (err) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `finalize-threw:${err?.message ?? err}`,
      });
      this.logger.warn?.(
        `[Finalizer] runFinalizeFn threw (swallowed): ${err?.message ?? err}`,
      );
      return;
    }

    if (finalize?.blocker) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `blocker:${finalize.blocker.reason}`,
      });
      this.logger.warn?.(
        `[Finalizer] finalize reported blocker (${finalize.blocker.reason}): ${finalize.blocker.detail ?? ''}`,
      );
      return;
    }
    const prUrl = finalize?.prUrl;
    if (typeof prUrl !== 'string' || prUrl.length === 0) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: 'no-pr-url',
      });
      this.logger.warn?.(
        '[Finalizer] runFinalizeFn returned no prUrl — cannot emit pr.created.',
      );
      return;
    }
    const prNumber =
      typeof finalize?.prNumber === 'number'
        ? finalize.prNumber
        : parsePrNumberFromUrl(prUrl);

    await this._emitFinalize({
      event,
      seqId,
      prUrl,
      prNumber,
      epicBranch,
      base: this._resolveBase(),
      outcome: 'opened',
    });
  }

  /**
   * Invoke the code-review graduator best-effort. Wired into finalize so
   * that surviving non-blocking findings get auto-filed as routed
   * follow-up issues (Story #2555 / Epic #2547). All failures are
   * captured and logged at warn level; the finalize pipeline continues
   * regardless — the toggle `delivery.feedbackLoop.codeReviewAutoFile`
   * is the only operator-facing kill switch.
   */
  async _runCodeReviewGraduation() {
    if (!this.provider || !this.currentRepo) {
      this.logger.debug?.(
        '[Finalizer] code-review graduation skipped: provider or currentRepo not wired',
      );
      return;
    }
    try {
      const summary = await this.graduateFindingsFn({
        epicId: this.epicId,
        provider: this.provider,
        config: this.config,
        currentRepo: this.currentRepo,
        frameworkRepo: this.frameworkRepo,
        cwd: this.cwd,
        logger: this.logger,
      });
      const filed = Array.isArray(summary?.filed) ? summary.filed.length : 0;
      const skipped = Array.isArray(summary?.skipped)
        ? summary.skipped.length
        : 0;
      const errors = Array.isArray(summary?.errors) ? summary.errors.length : 0;
      this.logger.info?.(
        `[Finalizer] code-review graduation: filed=${filed} skipped=${skipped} errors=${errors}`,
      );
      if (errors > 0) {
        this.logger.warn?.(
          `[Finalizer] code-review graduator errors: ${summary.errors.join('; ')}`,
        );
      }
    } catch (err) {
      this.logger.warn?.(
        `[Finalizer] code-review graduator threw (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Invoke the audit-results graduator best-effort. Wired into finalize
   * so that non-blocking audit findings (high/medium/low/suggestion) get
   * auto-filed as routed follow-up issues — Story #2615 / Epic #2586.
   */
  async _runAuditResultsGraduation() {
    if (!this.provider || !this.currentRepo) {
      this.logger.debug?.(
        '[Finalizer] audit-results graduation skipped: provider or currentRepo not wired',
      );
      return;
    }
    if (!isAuditResultsAutoFileEnabled(this.config)) {
      this.logger.debug?.(
        '[Finalizer] audit-results graduation skipped: auditResultsAutoFile toggle disabled',
      );
      return;
    }
    try {
      const summary = await this.graduateAuditResultsFn({
        epicId: this.epicId,
        provider: this.provider,
        config: this.config,
        currentRepo: this.currentRepo,
        frameworkRepo: this.frameworkRepo,
        cwd: this.cwd,
        logger: this.logger,
      });
      const filed = Array.isArray(summary?.filed) ? summary.filed.length : 0;
      const skipped = Array.isArray(summary?.skipped)
        ? summary.skipped.length
        : 0;
      const errors = Array.isArray(summary?.errors) ? summary.errors.length : 0;
      this.logger.info?.(
        `[Finalizer] audit-results graduation: filed=${filed} skipped=${skipped} errors=${errors}`,
      );
      if (errors > 0) {
        this.logger.warn?.(
          `[Finalizer] audit-results graduator errors: ${summary.errors.join('; ')}`,
        );
      }
    } catch (err) {
      this.logger.warn?.(
        `[Finalizer] audit-results graduator threw (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Emit the canonical finalize-success pair: `pr.created` →
   * `epic.finalize.end` in strict order. Helper carved out so the
   * existing-PR short-circuit and the freshly-opened path share the
   * same emit sequence.
   *
   * The Finalizer deliberately STOPS at `epic.finalize.end` and never
   * emits `epic.merge.ready` (Story #3367). Emitting `epic.merge.ready`
   * here would let `epic.close.end` cascade synchronously into the
   * auto-merge arm + branch reap, bypassing the AutomergePredicate gate.
   * The auto-merge arm flows ONLY through `pr.created` → Watcher →
   * `epic.watch.end` → AutomergePredicate → `epic.merge.ready`.
   *
   * `prNumber` stays in the classification log for trace/audit even
   * though it is no longer threaded onto an `epic.merge.ready` payload.
   */
  async _emitFinalize({
    event,
    seqId,
    prUrl,
    prNumber,
    epicBranch,
    base,
    outcome,
  }) {
    this.classifications.push({ event, seqId, outcome, prUrl, prNumber });
    try {
      await this.bus.emit('pr.created', {
        prUrl,
        head: epicBranch,
        base,
      });
    } catch (err) {
      this.logger.warn?.(
        `[Finalizer] pr.created emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
    try {
      await this.bus.emit('epic.finalize.end', {
        epicId: this.epicId,
        prUrl,
      });
    } catch (err) {
      this.logger.warn?.(
        `[Finalizer] epic.finalize.end emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Resolve the base branch for the PR. Always `main` today; pulled
   * into a helper so the listener owns the decision (and tests can
   * stub when a non-`main` base is wired in).
   */
  _resolveBase() {
    return 'main';
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}
