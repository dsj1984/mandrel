// .agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js
/**
 * Finalizer — lifecycle listener that owns the finalize-phase side
 * effects (push of `epic/<id>` + `gh pr create`) gated on a successful
 * acceptance reconciliation. Story #2253 / Task #2254 (Epic #2172).
 *
 * Subscribes to:
 *   - `acceptance.reconcile.ok` → run finalize. The Finalizer
 *     subscribes ONLY to `.ok` — `.skipped` proceeds without a PR
 *     (waiver / empty spec), `.failed` already routed to `epic.blocked`
 *     via the AcceptanceReconciler.
 *
 * Side effects executed inside `handle()`:
 *   1. Emit `epic.finalize.start`.
 *   2. FF check + `git push origin epic/<id>` via the legacy
 *      `runEpicDeliverFinalize` collaborator (passed as
 *      `runFinalizeFn`).
 *   3. Idempotency probe — `gh pr list --head epic/<id>` returns any
 *      existing PR URL. If one exists, short-circuit to a `pr.created`
 *      emit carrying that URL (no new PR opened).
 *   4. Otherwise, the wrapped finalize call runs `gh pr create` and
 *      returns the new PR URL.
 *   5. Emit `pr.created` then `epic.finalize.end`.
 *
 * Idempotency contract (AC-10): the `(event, seqId)` short-circuit on
 * the listener defends against bus-level replays; the
 * `gh pr list --head` probe defends against cross-process re-runs
 * (`/epic-deliver` restarted on the same branch after a crash). Either
 * is sufficient by itself; defence in depth is intentional.
 *
 * Side-effect firewall: the listener emits on the bus and shells out
 * to `gh`/`git`. It does NOT mutate ticket labels, post comments, or
 * call `notify` — those listeners receive `pr.created` /
 * `epic.finalize.end` and own their own side effects.
 *
 * Why a thin wrapper around `runEpicDeliverFinalize`: the legacy CLI
 * already implements FF + push + PR-create with the right retry
 * semantics; rebuilding it inside the listener would duplicate a
 * battle-tested code path. The wrapper extracts the PR URL from that
 * envelope and converts it into the lifecycle emits.
 */

import { spawnSync } from 'node:child_process';

import {
  graduateAuditResults as defaultGraduateAuditResults,
  isAutoFileEnabled as isAuditResultsAutoFileEnabled,
} from '../../../feedback-loop/audit-results-graduator.js';
import { graduateFindings as defaultGraduateFindings } from '../../../feedback-loop/code-review-graduator.js';

/**
 * Default `runFinalizeFn` — a no-op for D-1 (Epic #2306 Story #2319).
 *
 * The legacy `runEpicDeliverFinalize` CLI was collapsed to an emit
 * shim that fires `epic.close.end`; invoking it from inside the
 * Finalizer listener would re-enter the close-tail chain through
 * AcceptanceReconciler and recurse. Until a follow-up Story lifts the
 * FF + push + `gh pr create` flow into the listener body itself,
 * production callers MUST inject a working `runFinalizeFn`. Returning
 * a `blocker: 'd1-default-no-op'` here keeps the listener honest:
 * production runs that forget to wire the dependency degrade
 * loudly (the classification surface records the gap), and unit /
 * contract tests already inject their own stub via
 * `opts.runFinalizeFn`.
 */
function defaultRunEpicDeliverFinalize() {
  return {
    blocker: {
      reason: 'd1-default-no-op',
      detail:
        'Finalizer was constructed without an explicit runFinalizeFn; the D-1 shim cannot push or open a PR. Pass opts.runFinalizeFn to wire the production flow.',
    },
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
  // JSON array form: try parse and pull the first url.
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
  // Raw URL form.
  const match = trimmed.match(/^https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

/**
 * Default `gh` spawn used by the listener. The legacy
 * `epic-deliver-finalize` exports `GH_SPAWN_USES_SHELL = false`; we
 * mirror that contract here so a future Windows audit doesn't have to
 * grep across two modules. Exported so tests can stub.
 */
export function ghPrListHead({ epicBranch, cwd, spawnFn = spawnSync }) {
  // `--json url --jq '.[0].url'` collapses to either an empty string
  // (no PR) or the URL alone. Even without `gh` jq support the JSON
  // array form is parsed by `extractPrUrl`, so the listener is robust
  // to either output shape.
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
   * @param {boolean} [opts.fullScope] passed through to
   *   `runEpicDeliverFinalize`; defaults to false (diff-scope).
   * @param {Function} [opts.runFinalizeFn] override of
   *   `runEpicDeliverFinalize` for tests.
   * @param {Function} [opts.ghPrListHeadFn] override of the
   *   idempotency probe.
   * @param {object} [opts.provider] Ticketing provider forwarded to the
   *   code-review graduator (Story #2555 / Epic #2547). When omitted,
   *   the graduator step is skipped — auto-filing is best-effort.
   * @param {object} [opts.config] Resolved agent config; forwarded to
   *   the graduator so the `delivery.feedbackLoop.codeReviewAutoFile`
   *   toggle is honoured.
   * @param {{owner:string,repo:string}} [opts.currentRepo] Repo the
   *   listener is running in; used by the graduator's cross-repo guard.
   * @param {{owner:string,repo:string}} [opts.frameworkRepo] Optional
   *   framework-repo override for source-tagged finding routing.
   * @param {Function} [opts.graduateFindingsFn] Override of the
   *   `graduateFindings` helper for tests.
   * @param {Function} [opts.graduateAuditResultsFn] Override of the
   *   `graduateAuditResults` helper for tests (Story #2615 / Epic
   *   #2586). When `delivery.feedbackLoop.auditResultsAutoFile === false`
   *   the listener short-circuits and never invokes this function.
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
    this.runFinalizeFn = opts.runFinalizeFn ?? defaultRunEpicDeliverFinalize;
    this.ghPrListHeadFn = opts.ghPrListHeadFn ?? ghPrListHead;
    this.provider = opts.provider ?? null;
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
     * Classification log — every `acceptance.reconcile.ok` we observe
     * lands here with the outcome (`opened`, `existing`, `failed`,
     * `skipped-duplicate`). Mirrors the BlockerHandler / Reconciler
     * "no silent skip" surface.
     */
    this.classifications = [];
    this.events = Object.freeze(['acceptance.reconcile.ok']);
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
    //     Best-effort: never throws, listener failures are logged but
    //     do NOT block the finalize phase. Skipped silently when the
    //     provider / currentRepo wiring is absent (e.g. lifecycle-emit
    //     CLI runs without a provider).
    await this._runCodeReviewGraduation();

    // 1c. Auto-graduate non-blocking audit-results findings (Story
    //     #2615 / Epic #2586). Same best-effort contract as 1b; the
    //     `delivery.feedbackLoop.auditResultsAutoFile` toggle is checked
    //     up-front so the function is never invoked when disabled.
    await this._runAuditResultsGraduation();

    // 2. Idempotency probe — does a PR already exist on the head
    //    branch? If yes, short-circuit to a pr.created emit with the
    //    existing URL. This is the AC-10 contract for the most-risky
    //    non-trivial idempotency case (cross-process re-run after a
    //    crash between `gh pr create` and `pr.created` emit).
    const probe = this.ghPrListHeadFn({ epicBranch, cwd: this.cwd });
    if (probe.status === 0) {
      const existingUrl = extractPrUrl(probe.stdout);
      if (existingUrl) {
        this.logger.info?.(
          `[Finalizer] PR already open for ${epicBranch}: ${existingUrl} — short-circuiting create.`,
        );
        await this._emitPrCreated({
          event,
          seqId,
          prUrl: existingUrl,
          epicBranch,
          base: this._resolveBase(),
          outcome: 'existing',
        });
        return;
      }
    } else {
      // `gh pr list` itself failed; degrade to "no probe" rather than
      // throwing — the legacy finalize CLI will surface its own error
      // if push/create fails. We log the probe failure for audit.
      this.logger.warn?.(
        `[Finalizer] gh pr list probe failed (status=${probe.status}): ${probe.stderr} — proceeding with create.`,
      );
    }

    // 3. Run the legacy finalize. The CLI owns FF check + hotspot +
    //    baseline + push + `gh pr create`; we just thread the result
    //    into emit events. The CLI's inline acceptance reconciliation
    //    is still in place but is a no-op on the happy path (we just
    //    proved reconciliation passed by virtue of subscribing to
    //    `.ok`); leaving it in place during the cutover keeps the
    //    legacy direct-CLI invocation safe.
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
        `[Finalizer] runEpicDeliverFinalize threw (swallowed): ${err?.message ?? err}`,
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
        '[Finalizer] runEpicDeliverFinalize returned no prUrl — cannot emit pr.created.',
      );
      return;
    }

    await this._emitPrCreated({
      event,
      seqId,
      prUrl,
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
   *
   * Unlike the code-review graduator (which is always invoked and short-
   * circuits internally on its toggle), this method gates the call on
   * `delivery.feedbackLoop.auditResultsAutoFile` BEFORE invoking the
   * graduator. AC requires the function not to run when the toggle is
   * disabled, so the gate lives in the listener.
   *
   * All failures are captured and logged at warn level; the finalize
   * pipeline continues regardless.
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
   * Emit `pr.created` then `epic.finalize.end` in strict order. Helper
   * carved out so the existing-PR short-circuit and the freshly-opened
   * path share the same emit sequence.
   */
  async _emitPrCreated({ event, seqId, prUrl, epicBranch, base, outcome }) {
    this.classifications.push({ event, seqId, outcome, prUrl });
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

export function createFinalizer(opts) {
  return new Finalizer(opts);
}
