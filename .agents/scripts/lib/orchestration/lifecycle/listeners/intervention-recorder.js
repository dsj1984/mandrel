// .agents/scripts/lib/orchestration/lifecycle/listeners/intervention-recorder.js
/**
 * InterventionRecorder — lifecycle listener that persists out-of-band
 * manual interventions to the `epic-run-state` structured comment.
 *
 * Subscribes to (per Story #2410 / Task #2416):
 *   - `intervention.recorded` → calls `appendIntervention` on the
 *     `epic-run-state-store` so the `manualInterventions` array on the
 *     epic-run-state checkpoint comment grows by exactly one record.
 *
 * The lifecycle event is the canonical signal that the host LLM has
 * performed an out-of-band recovery (`AskUserQuestion`, manual
 * `git restore`, `--no-ff` recovery merge, `story-close --skipValidation`,
 * etc.). The auto-merge predicate reads the persisted array and only
 * fires when it is empty, so getting one record per emit is load-bearing.
 *
 * Idempotency contract (listeners/README.md): the listener keeps a
 * per-instance `Set<seqId>` of seqIds it has handled. A repeat
 * invocation with the same seqId short-circuits without calling the
 * store. (`epic-run-state-store.appendIntervention` is NOT idempotent
 * on its own — it always appends — so the seqId guard is the only
 * thing standing between a bus replay and a duplicated record.)
 *
 * Side-effect firewall (listeners/README.md):
 *   - MAY read/write the epic-run-state comment via the injected
 *     `provider` (through `epic-run-state-store`).
 *   - MUST NOT `bus.emit()` from inside the handler body — the bus is a
 *     sequential mediator and cannot re-enter safely.
 *   - MUST NOT import any module from
 *     `STATE_MUTATING_MODULES` in `check-lifecycle-lint.js`. The
 *     epic-run-state-store module is NOT on that blocklist; the lint
 *     rule treats it as a safe persistence boundary for listeners.
 */

import { appendIntervention } from '../../epic-run-state-store.js';

export const INTERVENTION_RECORDED_EVENT = 'intervention.recorded';

export class InterventionRecorder {
  /**
   * @param {object} opts
   * @param {object} opts.provider Ticketing provider threaded through to
   *   `appendIntervention`.
   * @param {number} opts.epicId Target ticket id (the Epic). Used both
   *   to scope `appendIntervention` and to filter incoming emits — a
   *   payload whose `epicId` does not match this listener's Epic is
   *   ignored (defensive; production wiring only ever emits with the
   *   listener's own epicId).
   * @param {{ warn?: Function, debug?: Function }} [opts.logger]
   * @param {Function} [opts.appendIntervention] Injected store fn —
   *   defaults to the canonical import. Tests pass a spy.
   */
  constructor(opts = {}) {
    if (!opts.provider) {
      throw new TypeError('InterventionRecorder requires a provider');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('InterventionRecorder requires a numeric epicId');
    }
    this.provider = opts.provider;
    this.epicId = opts.epicId;
    this.logger = opts.logger ?? console;
    this._appendIntervention =
      typeof opts.appendIntervention === 'function'
        ? opts.appendIntervention
        : appendIntervention;
    /** @type {Set<number>} seqIds we've already handled. */
    this._seen = new Set();
    this.events = Object.freeze([INTERVENTION_RECORDED_EVENT]);
  }

  /**
   * Subscribe to `intervention.recorded`. Returns the unsubscribe
   * handles so tests / teardown can detach without re-binding through
   * the bus's private registry.
   */
  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError(
        'InterventionRecorder.register requires a bus with on()',
      );
    }
    return this.events.map((event) =>
      bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  /**
   * Handle one `intervention.recorded` emit. Idempotent on seqId. The
   * payload has already been schema-validated by the bus, so `reason`
   * is guaranteed to be a non-empty string and `epicId` a positive
   * integer.
   *
   * @param {{ event: string, seqId: number, payload: { epicId: number, reason: string, source?: string, ts?: string } }} ctx
   */
  async handle({ event, seqId, payload }) {
    if (event !== INTERVENTION_RECORDED_EVENT) return;
    if (this._seen.has(seqId)) {
      this.logger.debug?.(
        `[InterventionRecorder] skip duplicate seqId=${seqId} (idempotent)`,
      );
      return;
    }
    // Defensive epicId filter — a misrouted emit (e.g., a shared bus in
    // tests) should not pollute a different Epic's state comment.
    if (payload?.epicId !== this.epicId) {
      this.logger.debug?.(
        `[InterventionRecorder] skip payload.epicId=${payload?.epicId} (listener bound to #${this.epicId})`,
      );
      return;
    }
    this._seen.add(seqId);

    const entry = {
      reason: payload.reason,
    };
    if (typeof payload.source === 'string' && payload.source.length > 0) {
      entry.source = payload.source;
    }
    if (typeof payload.ts === 'string' && payload.ts.length > 0) {
      entry.ts = payload.ts;
    }
    try {
      await this._appendIntervention({
        provider: this.provider,
        epicId: this.epicId,
        entry,
      });
    } catch (err) {
      this.logger.warn?.(
        `[InterventionRecorder] appendIntervention failed for seqId=${seqId}: ${err?.message ?? err}`,
      );
      throw err;
    }
  }

  resetSeen() {
    this._seen.clear();
  }
}
