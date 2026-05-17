// .agents/scripts/lib/orchestration/lifecycle/listeners/progress-reporter.js
/**
 * ProgressReporter — lifecycle listener that composes the
 * `epic-run-progress` rollup off `wave.end` and `story.dispatch.end`
 * events (Story #2239 Task #2244).
 *
 * The legacy `ProgressReporter` class (under
 * `epic-runner/progress-reporter.js`) is a tick-based comment writer
 * that polls the wave state every `intervalSec` seconds. This
 * lifecycle listener is the event-driven complement: it accumulates
 * outcomes off the bus and exposes a `snapshot()` accessor so the
 * legacy class (or a follow-up listener that owns the upsert itself)
 * can read the latest rollup without re-scanning the ledger.
 *
 * Subscribes to:
 *   - `story.dispatch.end` — increments the per-outcome counter
 *     (`done` / `blocked` / `failed` / `skipped`).
 *   - `wave.end` — records the wave's completion at the per-Epic
 *     level: which storyIds settled in which outcome, and stamps
 *     `currentWave`.
 *
 * Idempotency contract (Acceptance Spec AC-10): the listener keeps a
 * per-instance `Set<string>` of `event:seqId` keys it has handled. A
 * repeat invocation with the same key short-circuits without mutating
 * the accumulator.
 *
 * Side-effect firewall: this listener mutates only its own internal
 * state. It does NOT post comments, write signals, or fire webhooks
 * — those are the SignalsAppender and NotifyDispatcher listeners'
 * responsibilities, and the legacy `ProgressReporter` class still
 * owns the operator-facing comment upsert. Decoupling the rollup
 * accumulation here is a stepping-stone toward the follow-up Story
 * that removes the polling class altogether.
 */

export class ProgressReporter {
  /**
   * @param {object} [opts]
   * @param {{ debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    this.logger = opts.logger ?? console;
    this._seen = new Set();
    /** @type {{ done: number, blocked: number, failed: number, skipped: number }} */
    this._outcomes = { done: 0, blocked: 0, failed: 0, skipped: 0 };
    /** @type {number} 1-based wave counter; 0 until first `wave.end`. */
    this._currentWave = 0;
    /** @type {Array<{ waveIndex: number, outcomes: object }>} */
    this._wavesHistory = [];
    this.events = Object.freeze(['story.dispatch.end', 'wave.end']);
  }

  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError(
        'ProgressReporter.register requires a bus with on()',
      );
    }
    return this.events.map((event) =>
      bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[ProgressReporter] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    if (event === 'story.dispatch.end') {
      const outcome = payload?.outcome;
      if (
        outcome === 'done' ||
        outcome === 'blocked' ||
        outcome === 'failed' ||
        outcome === 'skipped'
      ) {
        this._outcomes[outcome] += 1;
      }
      return;
    }
    if (event === 'wave.end') {
      const waveIndex = Number(payload?.waveIndex);
      if (Number.isInteger(waveIndex)) {
        this._currentWave = waveIndex + 1;
        this._wavesHistory.push({
          waveIndex,
          outcomes: { ...(payload?.outcomes ?? {}) },
        });
      }
    }
  }

  /**
   * Snapshot accessor — returns the current rollup. Pure read; safe to
   * call as often as the host wants. The shape matches the payload the
   * legacy `composition.js` consumes for the `epic-run-progress`
   * comment body so a follow-up Story can wire this listener directly
   * to the upsert without reshaping.
   */
  snapshot() {
    return {
      outcomes: { ...this._outcomes },
      currentWave: this._currentWave,
      waves: this._wavesHistory.map((w) => ({
        waveIndex: w.waveIndex,
        outcomes: { ...w.outcomes },
      })),
    };
  }

  resetSeen() {
    this._seen.clear();
  }
}

export function createProgressReporter(opts) {
  return new ProgressReporter(opts);
}
