// .agents/scripts/lib/orchestration/lifecycle/listeners/timeout-watchdog.js
/**
 * TimeoutWatchdog — lifecycle observer that enforces per-event wall-clock
 * budgets as defense in depth for the spawn-level timeouts already in
 * place from Story #2165.
 *
 * Subscribes to:
 *   - `'*'` (wildcard observer) — inspects every emit and reacts to the
 *     `<phase>.start` / `<phase>.end` pair shape. On a `*.start` it starts
 *     a `setTimeout(budgetMs)` keyed by the stripped phase name; on the
 *     matching `*.end` it clears that timer. If the timer expires before
 *     the matching `*.end` lands, it emits `epic.blocked` with the typed
 *     reason `timeout:<event>` so the BlockerHandler / LabelTransitioner
 *     chain can persist the cascade.
 *
 * Wildcard-observer firewall (Wave 0 / Story #2227):
 *   - This module is the ONE wildcard observer that emits. It satisfies
 *     the firewall lint rule (`check-lifecycle-lint.js`'s Rule 2) by
 *     importing NO state-mutating modules — the only side effect it
 *     produces is a `bus.emit('epic.blocked', …)` callback fired from
 *     an out-of-band `setTimeout`. The bus is not in the firewall's
 *     blocklist (it is the mediator, not a state writer); the
 *     downstream `epic.blocked` listeners (LabelTransitioner,
 *     StructuredCommentPoster, etc.) own all GitHub / disk side effects
 *     and run on the next tick of the event loop, not from inside this
 *     listener body.
 *
 * Bus re-entry safety:
 *   - The wildcard handler itself is a no-op for non-`.start` / non-`.end`
 *     events; it never calls `bus.emit()` from inside the handler body.
 *   - The expiry callback is invoked by Node's timer queue, NOT by the
 *     bus emit loop, so `bus.emit('epic.blocked', …)` runs on a fresh
 *     stack with no in-flight listener iteration to corrupt.
 *
 * Budget resolution:
 *   - Per-event budgets are read from `delivery.lifecycle.timeouts` on
 *     `.agentrc.json` (schema gate already in place from Wave 0). The
 *     map keys are the event names being timed (e.g. `acceptance.reconcile`,
 *     `epic.finalize`, `epic.watch`) — values are seconds. The watchdog
 *     converts seconds → milliseconds at timer-start time so the schema
 *     stays human-friendly.
 *   - Events without a configured budget are skipped silently (no timer
 *     is started); the watchdog is opt-in per phase.
 *
 * Idempotency:
 *   - Restarting the same `<phase>.start` while an existing timer is
 *     active replaces the prior timer (re-arming counts the new emit's
 *     wall clock). This matches the "resume re-runs from a known event"
 *     contract on the bus.
 *   - An expiry fires `epic.blocked` exactly once per phase per run;
 *     after expiry the timer record is cleared and the matching `*.end`
 *     (if it ever lands) is a no-op.
 */

/**
 * Resolve the phase name that pairs `*.start` / `*.end`. Pure — exported
 * for tests so the suffix-strip contract is reviewable.
 *
 * Examples:
 *   - `acceptance.reconcile.start` → `'acceptance.reconcile'`
 *   - `epic.finalize.end`          → `'epic.finalize'`
 *   - `wave.start`                 → `'wave'`
 *   - `epic.blocked`               → `null` (not a paired phase event)
 *
 * @param {string} event
 * @returns {{ phase: string, boundary: 'start' | 'end' } | null}
 */
export function parsePhaseEvent(event) {
  if (typeof event !== 'string' || event.length === 0) return null;
  if (event.endsWith('.start')) {
    return { phase: event.slice(0, -'.start'.length), boundary: 'start' };
  }
  if (event.endsWith('.end')) {
    return { phase: event.slice(0, -'.end'.length), boundary: 'end' };
  }
  return null;
}

/**
 * TimeoutWatchdog — instantiate one per Epic run and call `.register(bus)`
 * to attach the wildcard observer. The instance owns the timer map so
 * the runner can call `.dispose()` at run-tail to clear any leaked
 * timers (defensive — the matching `*.end` should always land in a
 * well-formed run).
 */
export class TimeoutWatchdog {
  /**
   * @param {object} opts
   * @param {Record<string, number>} [opts.timeouts] per-event budget map
   *   in SECONDS, indexed by phase name (e.g. `'acceptance.reconcile'`).
   *   Missing entries skip timer arming for that phase.
   * @param {{ warn?: Function, info?: Function, debug?: Function }} [opts.logger]
   *   Optional logger; defaults to `console`.
   * @param {Function} [opts.setTimeoutFn] timer factory override for
   *   tests (must mirror Node's `setTimeout(fn, ms)` signature).
   * @param {Function} [opts.clearTimeoutFn] timer cancel override for
   *   tests (must mirror Node's `clearTimeout(handle)` signature).
   */
  constructor(opts = {}) {
    this.timeouts =
      opts.timeouts && typeof opts.timeouts === 'object' ? opts.timeouts : {};
    this.logger = opts.logger ?? console;
    this._setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this._clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    /** @type {Map<string, { handle: any, event: string, seqId: number }>} */
    this._timers = new Map();
    /**
     * Classification log — every `*.start` / `*.end` the watchdog
     * observes lands here with the outcome (`armed`, `cleared`,
     * `expired`, `skipped`, `replaced`). Mirrors the no-silent-skip
     * surface on the other listeners.
     * @type {Array<{ event: string, phase: string, outcome: string, reason?: string, seqId?: number }>}
     */
    this.classifications = [];
    /**
     * Expiry log — every fired `epic.blocked` emit is recorded here so
     * tests can assert exactly-once semantics without depending on the
     * bus's seqId monotonicity.
     * @type {Array<{ phase: string, reason: string, seqId: number }>}
     */
    this.expirations = [];
    this._bus = null;
  }

  /**
   * Resolve the budget for a phase in milliseconds. Returns `null` when
   * no budget is configured (the phase is opted out of the watchdog).
   */
  _budgetMs(phase) {
    const seconds = this.timeouts[phase];
    if (!Number.isInteger(seconds) || seconds < 1) return null;
    return seconds * 1000;
  }

  /**
   * Register as a wildcard observer on the supplied bus. The bus
   * reference is captured so the expiry callback can call `bus.emit()`
   * out-of-band. Returns the unsubscribe function the bus's `on()`
   * provides so callers can detach in tests.
   */
  register(bus) {
    if (
      !bus ||
      typeof bus.on !== 'function' ||
      typeof bus.emit !== 'function'
    ) {
      throw new TypeError(
        'TimeoutWatchdog.register: bus must expose .on() and .emit()',
      );
    }
    this._bus = bus;
    return bus.on('*', ({ event, seqId }) => {
      this._handle(event, seqId);
    });
  }

  /**
   * Internal handler — synchronous because the wildcard observer must
   * not block the bus's listener loop. Timer arming and clearing are
   * both O(1) Map operations.
   */
  _handle(event, seqId) {
    const parsed = parsePhaseEvent(event);
    if (parsed === null) return; // not a paired-phase event; observer is silent

    const { phase, boundary } = parsed;
    if (boundary === 'start') {
      const budgetMs = this._budgetMs(phase);
      if (budgetMs === null) {
        this.classifications.push({
          event,
          phase,
          outcome: 'skipped',
          reason: 'no-budget-configured',
          seqId,
        });
        return;
      }
      // Replace any prior timer for the same phase (re-arming on
      // re-emit). The classification log distinguishes a clean arm
      // from a replacement so test assertions can pin both branches.
      const prior = this._timers.get(phase);
      if (prior) {
        this._clearTimeoutFn(prior.handle);
        this.classifications.push({
          event,
          phase,
          outcome: 'replaced',
          seqId,
        });
      } else {
        this.classifications.push({
          event,
          phase,
          outcome: 'armed',
          seqId,
        });
      }
      const handle = this._setTimeoutFn(() => {
        this._expire(phase, seqId);
      }, budgetMs);
      // `setTimeout` in Node returns a Timeout object that supports
      // `.unref()` — keeping the timer unref'd prevents a hung phase
      // from holding the process open at the run-tail. Tests pass a
      // synchronous fake that doesn't implement `.unref`; guard.
      if (handle && typeof handle.unref === 'function') handle.unref();
      this._timers.set(phase, { handle, event, seqId });
      return;
    }

    // boundary === 'end'
    const armed = this._timers.get(phase);
    if (!armed) {
      this.classifications.push({
        event,
        phase,
        outcome: 'skipped',
        reason: 'no-armed-timer',
        seqId,
      });
      return;
    }
    this._clearTimeoutFn(armed.handle);
    this._timers.delete(phase);
    this.classifications.push({
      event,
      phase,
      outcome: 'cleared',
      seqId,
    });
  }

  /**
   * Expiry callback — invoked by the timer queue, NOT inside the bus
   * listener loop. Emits `epic.blocked` with the typed reason
   * `timeout:<phase>` so downstream `epic.blocked` listeners
   * (LabelTransitioner, StructuredCommentPoster, NotifyDispatcher)
   * cascade their side effects.
   */
  _expire(phase, originatingSeqId) {
    // Clear the timer record FIRST so a late-arriving `*.end` for the
    // same phase becomes a no-op rather than logging a confusing
    // "cleared after expiry" line.
    this._timers.delete(phase);
    const reason = `timeout:${phase}`;
    this.classifications.push({
      event: `${phase}.timeout`,
      phase,
      outcome: 'expired',
      reason,
      seqId: originatingSeqId,
    });
    if (!this._bus) return;
    // Emit asynchronously without awaiting — the timer callback is
    // synchronous and we don't want unhandled rejections from
    // downstream listeners (e.g. the LabelTransitioner shelling out to
    // GitHub) to bubble out of the timer queue.
    Promise.resolve(this._bus.emit('epic.blocked', { reason }))
      .then((result) => {
        this.expirations.push({
          phase,
          reason,
          seqId: result?.seqId ?? -1,
        });
      })
      .catch((err) => {
        this.logger.warn?.(
          `[TimeoutWatchdog] epic.blocked emit failed for ${phase}: ${err?.message ?? err}`,
        );
      });
  }

  /**
   * Clear any remaining armed timers. The runner should call this at
   * run-tail (success or failure) so timer references don't leak into
   * a subsequent run inside the same process — important for the
   * integration test fixture which constructs many short-lived bus
   * instances.
   */
  dispose() {
    for (const { handle } of this._timers.values()) {
      this._clearTimeoutFn(handle);
    }
    this._timers.clear();
  }

  /**
   * Test introspection — read-only snapshot of the armed-timer set,
   * keyed by phase. Useful for assertions about which phases are
   * still in flight after a sequence of emits.
   */
  get armedPhases() {
    return [...this._timers.keys()];
  }
}

export function createTimeoutWatchdog(opts) {
  return new TimeoutWatchdog(opts);
}
