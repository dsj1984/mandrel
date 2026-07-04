// .agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js
/**
 * AcceptanceReconciler — lifecycle listener that gates Finalize on the
 * close-time acceptance-spec reconciliation. Story #2253 (Epic #2172):
 * the reconciliation moves *ahead* of the push + `gh pr create` call so
 * that AC coverage gaps block PR creation (review High-2).
 *
 * Subscribes to:
 *   - `epic.close.end` → emit `acceptance.reconcile.start`, run the
 *     `reconcileAcceptanceSpec` helper, emit one of
 *     `acceptance.reconcile.ok | .waived | .skipped | .failed`, and on
 *     `.failed` also emit `epic.blocked` so the LabelTransitioner /
 *     StructuredCommentPoster / NotifyDispatcher trio fire the blocker
 *     side effects exactly as a `story.blocked` cascade would.
 *
 * The Finalizer listener subscribes ONLY to `acceptance.reconcile.ok`,
 * so this listener is the authoritative safety gate ahead of any push
 * or PR-create work. The legacy `epic-deliver-finalize.js` shim still
 * exists for backwards compatibility, but its in-line reconciliation
 * call is replaced by the event-driven path.
 *
 * Idempotency contract (Acceptance Spec AC-10):
 *   - Per-instance `Set<string>` of `${event}:${seqId}` keys. A repeat
 *     `(event, seqId)` short-circuits without re-running reconciliation
 *     and emits no events.
 *   - The reconciler helper's only write is the section-scoped
 *     disposition record inside the Epic body's ## Acceptance Table
 *     region (Story #4324) — itself idempotent — so the seqId guard is
 *     the only defence the listener needs.
 *
 * Side-effect firewall: the listener owns the reconciliation call and
 * the four outcome emits. It does NOT mutate labels, post comments, or
 * call `notify` directly — those are downstream listener concerns.
 */

import { reconcileAcceptanceSpec as defaultReconcileAcceptanceSpec } from '../../../../acceptance-spec-reconciler.js';

/**
 * Classify a `reconcileAcceptanceSpec` result envelope into the typed
 * outcome event the listener should emit. Pure function — exported so
 * unit tests can drive every branch without a bus instance.
 *
 * The reconciler exposes a four-value `status` discriminant:
 *   - `'waived'`     → the Epic carries `acceptance::n-a` (or no linked
 *                       spec under `--skip-when-waived`). Emit
 *                       `acceptance.reconcile.waived` with reason
 *                       `'waiver'`. Story #2893 split this out from
 *                       `.skipped` so the Finalizer can subscribe to
 *                       `.waived` and route waived Epics through to PR
 *                       creation, while empty-spec Epics still
 *                       terminate without a PR via `.skipped`.
 *   - `'empty-spec'` → the linked spec exists but declares zero AC IDs.
 *                       Treated as "no work to do"; emit `.skipped` with
 *                       reason `'empty-spec'` so operators see the
 *                       outcome explicitly (no silent skip).
 *   - `'ok'`         → the spec has AC IDs and every one is covered by
 *                       a non-pending scenario. Emit `.ok`.
 *   - `'gap'`        → at least one AC is pending or missing. Emit
 *                       `.failed` carrying a compact reason summary;
 *                       the listener then emits `epic.blocked` to flip
 *                       the Epic ticket.
 *
 * @param {object|undefined|null} result reconciler envelope.
 * @returns {{ outcome: 'ok'|'waived'|'skipped'|'failed', reason?: string }}
 */
export function classifyReconcileResult(result) {
  if (!result || typeof result !== 'object') {
    return { outcome: 'failed', reason: 'reconciler-no-result' };
  }
  const status = result.status;
  if (status === 'waived') {
    return { outcome: 'waived', reason: 'waiver' };
  }
  if (status === 'empty-spec') {
    return { outcome: 'skipped', reason: 'empty-spec' };
  }
  if (status === 'ok') {
    return { outcome: 'ok' };
  }
  if (status === 'gap') {
    const missing = Array.isArray(result.missing) ? result.missing : [];
    const pending = Array.isArray(result.pending) ? result.pending : [];
    const parts = [];
    if (missing.length > 0) parts.push(`missing=${missing.join(',')}`);
    if (pending.length > 0) parts.push(`pending=${pending.join(',')}`);
    const reason =
      parts.length > 0 ? `gap:${parts.join(';')}` : 'gap:unspecified';
    return { outcome: 'failed', reason };
  }
  // Unknown status — fail closed so the operator sees the surprise.
  return { outcome: 'failed', reason: `unknown-status:${String(status)}` };
}

/**
 * AcceptanceReconciler — instantiate one per Epic run and call
 * `register()` to wire it onto the bus. Stateless w.r.t. the system
 * under orchestration; per-run state is the `(event, seqId)`
 * idempotency cache + the classification log.
 */
export class AcceptanceReconciler {
  /**
   * @param {object} opts
   * @param {object} opts.bus Lifecycle bus instance (must expose
   *   `on()` and `emit()`).
   * @param {number} opts.epicId Epic ticket id.
   * @param {string} [opts.cwd] Working directory passed through to the
   *   reconciler helper. Defaults to `process.cwd()`.
   * @param {object} [opts.provider] Ticketing provider — injected into
   *   the reconciler call so the lifecycle bus does not need to
   *   construct one itself.
   * @param {object} [opts.config] Resolved orchestration config —
   *   injected for the same reason.
   * @param {Function} [opts.reconcileAcceptanceSpecFn] Override of the
   *   helper for tests; defaults to the production export.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError(
        'AcceptanceReconciler requires a bus with on() and emit()',
      );
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('AcceptanceReconciler requires a numeric epicId');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.cwd = opts.cwd ?? process.cwd();
    this.provider = opts.provider ?? null;
    this.config = opts.config ?? null;
    this.reconcileAcceptanceSpecFn =
      opts.reconcileAcceptanceSpecFn ?? defaultReconcileAcceptanceSpec;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` keys we've handled. */
    this._seen = new Set();
    /**
     * Classification log — mirrors the BlockerHandler "no silent skip"
     * surface so tests can confirm every `epic.close.end` we observed
     * was classified into exactly one outcome.
     *
     * @type {Array<{ event: string, seqId: number, outcome: string, reason?: string }>}
     */
    this.classifications = [];
    this.events = Object.freeze(['epic.close.end']);
  }

  /**
   * Register this listener on the bus. Returns an array of unsubscribe
   * functions (one per event) for test teardown.
   */
  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  /**
   * Bus listener body. The bus passes `{ event, seqId, payload }`. The
   * listener:
   *   1. Idempotently short-circuits a repeat `(event, seqId)`.
   *   2. Emits `acceptance.reconcile.start`.
   *   3. Runs `reconcileAcceptanceSpec` with injected provider/config.
   *   4. Emits exactly one of `.ok` / `.skipped` / `.failed`.
   *   5. On `.failed`, additionally emits `epic.blocked` so the
   *      downstream listener trio (label flip + structured comment +
   *      notify) fires the operator-visible blocker side effects.
   *
   * The listener does NOT throw on reconciler failures: the bus's
   * `onFailed` boundary already persists the originating
   * `epic.close.end` record; surfacing a throw here would short-circuit
   * other `epic.close.end` listeners (e.g. trace logger) and is not
   * needed for correctness — the `acceptance.reconcile.failed` +
   * `epic.blocked` emits are the cascade contract.
   *
   * @param {{ event: string, seqId: number, payload: object }} ctx
   */
  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(
        `[AcceptanceReconciler] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const epicIdFromPayload = Number(payload?.epicId);
    const epicId = Number.isInteger(epicIdFromPayload)
      ? epicIdFromPayload
      : this.epicId;

    // 1. Start emit. The downstream lifecycle-diff `reconcile-ordering`
    //    assert checks for `acceptance.reconcile.ok` before `pr.created`,
    //    but operators want to see the `.start` marker in the trace too.
    try {
      await this.bus.emit('acceptance.reconcile.start', { epicId });
    } catch (err) {
      // Schema validation against a known-good payload should never
      // throw; if it does, surface and bail — there's no point running
      // the reconciler when we cannot announce its outcome.
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `start-emit-failed:${err?.message ?? err}`,
      });
      this.logger.warn?.(
        `[AcceptanceReconciler] acceptance.reconcile.start emit failed: ${err?.message ?? err}`,
      );
      return;
    }

    // 2. Run the reconciler. The helper itself throws on hard errors
    //    (no linked spec + no waiver, etc.); convert those into
    //    `.failed` emits rather than re-propagating, so the cascade
    //    contract holds even when the spec is malformed.
    let result;
    let thrown = null;
    try {
      result = await this.reconcileAcceptanceSpecFn({
        epicId,
        cwd: this.cwd,
        injectedProvider: this.provider ?? undefined,
        injectedConfig: this.config ?? undefined,
        loggerImpl: this.logger,
        // Honour `acceptance::n-a` — the helper already returns
        // `status: 'waived'` for that label, but `skipWhenWaived: true`
        // additionally tolerates a missing acceptance-table section under
        // the waiver (we want the same forgiving stance the inline
        // finalize call had).
        skipWhenWaived: true,
        // Close time is the one place the verification outcome is
        // recorded into the Epic body's ## Acceptance Table section
        // (section-scoped write, Story #4324).
        writeDispositions: true,
      });
    } catch (err) {
      thrown = err;
    }

    const baseRead = thrown == null && result != null;

    if (thrown != null) {
      const reason = `reconcile-threw:${thrown?.message ?? thrown}`;
      await this._emitFailure({ event, seqId, baseRead, reason });
      return;
    }

    const classification = classifyReconcileResult(result);
    if (classification.outcome === 'ok') {
      await this._emitOk({ event, seqId, baseRead });
      return;
    }
    if (classification.outcome === 'waived') {
      await this._emitWaived({
        event,
        seqId,
        baseRead,
        reason: classification.reason ?? 'waiver',
      });
      return;
    }
    if (classification.outcome === 'skipped') {
      await this._emitSkipped({
        event,
        seqId,
        baseRead,
        reason: classification.reason ?? 'skipped',
      });
      return;
    }
    await this._emitFailure({
      event,
      seqId,
      baseRead,
      reason: classification.reason ?? 'gap',
    });
  }

  /**
   * Emit `acceptance.reconcile.ok` and record the classification.
   * Helper carved out so each branch in `handle()` reads as a single
   * decision.
   */
  async _emitOk({ event, seqId, baseRead }) {
    this.classifications.push({ event, seqId, outcome: 'ok' });
    try {
      await this.bus.emit('acceptance.reconcile.ok', { baseRead });
    } catch (err) {
      this.logger.warn?.(
        `[AcceptanceReconciler] acceptance.reconcile.ok emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Emit `acceptance.reconcile.waived` for the `acceptance::n-a` path.
   * Story #2893 split this out of `.skipped` so the Finalizer can
   * subscribe to `.waived` and route waived Epics through to PR
   * creation. The schema pins `reason` to `'waiver'`.
   */
  async _emitWaived({ event, seqId, baseRead, reason }) {
    this.classifications.push({ event, seqId, outcome: 'waived', reason });
    try {
      await this.bus.emit('acceptance.reconcile.waived', {
        baseRead,
        reason,
      });
    } catch (err) {
      this.logger.warn?.(
        `[AcceptanceReconciler] acceptance.reconcile.waived emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Emit `acceptance.reconcile.skipped` carrying a typed `reason`. The
   * schema requires `reason` to be non-empty so callers always pass one
   * (no silent skip).
   */
  async _emitSkipped({ event, seqId, baseRead, reason }) {
    this.classifications.push({ event, seqId, outcome: 'skipped', reason });
    try {
      await this.bus.emit('acceptance.reconcile.skipped', {
        baseRead,
        reason,
      });
    } catch (err) {
      this.logger.warn?.(
        `[AcceptanceReconciler] acceptance.reconcile.skipped emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Emit `acceptance.reconcile.failed` and then `epic.blocked`, in that
   * order. The `epic.blocked` emit drives the LabelTransitioner /
   * StructuredCommentPoster / NotifyDispatcher trio so the operator
   * sees the blocker label flip + structured comment + webhook,
   * exactly as a `story.blocked` cascade would.
   *
   * Failures inside the `epic.blocked` emit are swallowed (the
   * `.failed` record is already on the ledger; double-throwing here
   * would mask the original reason).
   */
  async _emitFailure({ event, seqId, baseRead, reason }) {
    this.classifications.push({ event, seqId, outcome: 'failed', reason });
    try {
      await this.bus.emit('acceptance.reconcile.failed', {
        baseRead,
        reason,
      });
    } catch (err) {
      this.logger.warn?.(
        `[AcceptanceReconciler] acceptance.reconcile.failed emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
    try {
      await this.bus.emit('epic.blocked', {
        reason: `acceptance-reconcile:${reason}`,
      });
    } catch (err) {
      this.logger.warn?.(
        `[AcceptanceReconciler] epic.blocked emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /** Test helper — wipe the idempotency cache. */
  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}
