// .agents/scripts/lib/orchestration/lifecycle/listeners/heartbeat-monitor.js
/**
 * HeartbeatMonitor — passive wildcard observer that surfaces a warning
 * through the injected logger when the lifecycle bus goes silent for
 * longer than `delivery.lifecycle.heartbeatWarnSeconds` (default 60).
 *
 * Subscribes to:
 *   - `'*'` (wildcard observer) — records the wall-clock of every emit
 *     and, on the next emit (or on an explicit `check()` call from the
 *     runner), surfaces one warning per quiet gap that crosses the
 *     threshold. The monitor does NOT itself schedule any timers — the
 *     observation surface is purely "what arrived, and how long since
 *     the previous one" — which keeps the firewall trivially provable
 *     and avoids contention with the TimeoutWatchdog's timer queue.
 *
 * Wildcard-observer firewall (Wave 0 / Story #2227):
 *   - This module imports NO state-mutating modules. It owns no bus
 *     emission, no GitHub call, no ledger or disk write. The single
 *     side effect it produces is `logger.warn(…)` on the injected
 *     logger — the runner's standard observability channel — which the
 *     lint rule's blocklist does not (and must not) cover.
 *   - The monitor MUST NOT call `bus.emit()` from anywhere. The Tech
 *     Spec's wildcard contract is "trace / heartbeat observers MUST
 *     NOT perform side effects on the system under orchestration";
 *     surfacing a warning via the logger is the canonical observer
 *     escape hatch.
 *
 * Idempotency:
 *   - Each quiet gap surfaces AT MOST one warning. The internal
 *     `_warnedForGapEndingAt` cursor is the wall-clock of the
 *     post-gap emit; subsequent re-checks against the same gap are
 *     no-ops. Restarting the run (or a fresh instance) resets the
 *     cursor — appropriate, because resume is a new observation
 *     window from the operator's perspective.
 *
 * Why not a setInterval?
 *   - A periodic poll would either (a) need to reach into the bus's
 *     emit cycle (re-entrant — forbidden) or (b) consult only the
 *     monitor's own clock (effectively the same as the
 *     "check-on-next-emit" pattern, but with extra timer cleanup).
 *   - The runner can call `check()` directly at any phase boundary
 *     (e.g. before a long-running sub-process spawn) to force a
 *     pre-emptive evaluation without waiting for the next emit.
 */

/**
 * Default no-progress threshold in seconds. Used when no
 * `heartbeatWarnSeconds` is configured at construction time. Mirrors
 * the schema default documented in `delivery.lifecycle.heartbeatWarnSeconds`.
 */
export const DEFAULT_HEARTBEAT_WARN_SECONDS = 60;

/**
 * HeartbeatMonitor — instantiate one per Epic run and call
 * `.register(bus)` to attach the wildcard observer. The monitor stays
 * silent until two emits arrive with a gap that crosses the
 * configured threshold, at which point it surfaces exactly one
 * `logger.warn` per gap.
 */
export class HeartbeatMonitor {
  /**
   * @param {object} opts
   * @param {number} [opts.warnSeconds] no-progress threshold in seconds;
   *   defaults to `DEFAULT_HEARTBEAT_WARN_SECONDS` (60).
   * @param {{ warn?: Function, info?: Function, debug?: Function }} [opts.logger]
   *   Optional logger; defaults to `console`. `logger.warn` is the ONLY
   *   surface the monitor uses to communicate.
   * @param {Function} [opts.nowFn] injectable wall-clock for tests; must
   *   return milliseconds (matches `Date.now`).
   */
  constructor(opts = {}) {
    const seconds = Number.isInteger(opts.warnSeconds)
      ? opts.warnSeconds
      : DEFAULT_HEARTBEAT_WARN_SECONDS;
    if (seconds < 1) {
      throw new RangeError(
        'HeartbeatMonitor: warnSeconds must be a positive integer',
      );
    }
    this.warnSeconds = seconds;
    this.warnMs = seconds * 1000;
    this.logger = opts.logger ?? console;
    this._nowFn = opts.nowFn ?? Date.now;
    /** @type {number | null} wall-clock of the most recent emit. */
    this._lastEmitMs = null;
    /** @type {string | null} event name of the most recent emit. */
    this._lastEvent = null;
    /**
     * Wall-clock of the most recent emit that has already produced a
     * warning. Prevents duplicate warns for the same gap when `check()`
     * is called repeatedly or when a re-entry is theoretically possible.
     * @type {number | null}
     */
    this._warnedForGapEndingAt = null;
    /**
     * Surfacing log — one entry per `logger.warn` call. Exposed for
     * tests so the exactly-once contract is assertable without spying
     * on the logger.
     * @type {Array<{ event: string, gapMs: number, previousEvent: string | null }>}
     */
    this.warnings = [];
  }

  /**
   * Register as a wildcard observer on the supplied bus. Returns the
   * bus's unsubscribe handle for tests.
   */
  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError('HeartbeatMonitor.register: bus must expose .on()');
    }
    return bus.on('*', ({ event }) => {
      this._observe(event);
    });
  }

  /**
   * Record an emit and, if the gap since the previous emit crosses the
   * threshold, surface one warning. Synchronous — the wildcard listener
   * contract requires the handler return promptly (the bus's listener
   * loop awaits it).
   */
  _observe(event) {
    const now = this._nowFn();
    const prevMs = this._lastEmitMs;
    const prevEvent = this._lastEvent;
    if (prevMs !== null) {
      const gapMs = now - prevMs;
      if (gapMs >= this.warnMs && this._warnedForGapEndingAt !== now) {
        this._warnedForGapEndingAt = now;
        this.warnings.push({
          event,
          gapMs,
          previousEvent: prevEvent,
        });
        this.logger.warn?.(
          `[HeartbeatMonitor] no lifecycle progress for ${Math.round(gapMs / 1000)}s ` +
            `(prev=${prevEvent ?? '(none)'} → next=${event}); threshold=${this.warnSeconds}s`,
        );
      }
    }
    this._lastEmitMs = now;
    this._lastEvent = event;
  }

  /**
   * Operator-callable: force a heartbeat check WITHOUT a new emit. Used
   * by the runner before a long-running sub-process spawn so the
   * warning fires even when the lifecycle bus is intentionally quiet
   * (e.g. during a long `gh pr checks` poll loop where the
   * `epic.watch.start` / `epic.watch.end` pair brackets a multi-minute
   * gap).
   *
   * Returns the surfaced warning record (or `null` if the gap is
   * below threshold or no prior emit exists).
   */
  check() {
    if (this._lastEmitMs === null) return null;
    const now = this._nowFn();
    const gapMs = now - this._lastEmitMs;
    if (gapMs < this.warnMs) return null;
    if (this._warnedForGapEndingAt === now) return null;
    this._warnedForGapEndingAt = now;
    const record = {
      event: '(check)',
      gapMs,
      previousEvent: this._lastEvent,
    };
    this.warnings.push(record);
    this.logger.warn?.(
      `[HeartbeatMonitor] no lifecycle progress for ${Math.round(gapMs / 1000)}s ` +
        `(prev=${record.previousEvent ?? '(none)'}); threshold=${this.warnSeconds}s`,
    );
    return record;
  }

  /**
   * Test introspection — read-only snapshot of the current observation
   * cursor. Mirrors the pattern on TimeoutWatchdog.armedPhases.
   */
  get lastEmit() {
    if (this._lastEmitMs === null) return null;
    return { event: this._lastEvent, atMs: this._lastEmitMs };
  }

  /**
   * Reset the observation cursor and warnings log. The runner can
   * call this between resume cycles if it wants a fresh observation
   * window (default behavior is to carry state across the run; the
   * cursor naturally drifts forward as emits arrive).
   */
  reset() {
    this._lastEmitMs = null;
    this._lastEvent = null;
    this._warnedForGapEndingAt = null;
    this.warnings = [];
  }
}

export function createHeartbeatMonitor(opts) {
  return new HeartbeatMonitor(opts);
}
