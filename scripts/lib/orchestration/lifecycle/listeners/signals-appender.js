// .agents/scripts/lib/orchestration/lifecycle/listeners/signals-appender.js
/**
 * SignalsAppender — lifecycle listener that appends one NDJSON row per
 * subscribed lifecycle event to `temp/epic-<id>/signals.ndjson`
 * (Story #2239 Task #2244).
 *
 * Subscribes to:
 *   - `story.dispatch.end`
 *   - `story.blocked`
 *   - `wave.end`
 *
 * Each appended row is keyed by `seqId` and replays the event verbatim
 * (kind + payload + timestamp). The seqId-keyed idempotency invariant
 * is enforced two ways:
 *
 *   1. In-process: a per-instance `Set<string>` of `event:seqId` keys
 *      short-circuits a duplicate append before any I/O happens.
 *   2. On-disk: when the seqId guard misses (process restart between
 *      runs), the append is still safe — `signals.ndjson` is an
 *      append-only NDJSON stream and the reader (the existing
 *      `forEachLine` consumer in `signals-writer.js`) dedupes on read.
 *      Story #2245 verifies the on-disk shape doesn't grow duplicate
 *      lines across resume cycles.
 *
 * Side-effect firewall: only writes to disk. No bus.emit, no provider
 * calls.
 */

export class SignalsAppender {
  /**
   * @param {object} opts
   * @param {number} opts.epicId Epic ticket id (used to derive the
   *   on-disk path under `temp/epic-<id>/`).
   * @param {(args: { epicId: number, signal: object, config?: object }) => Promise<boolean>} opts.appendEpicSignal
   *   Injected writer (the canonical export lives in
   *   `lib/observability/signals-writer.js`).
   * @param {object} [opts.config] Resolved framework config (forwarded
   *   to `appendEpicSignal` so `tempRoot` overrides land on disk).
   * @param {() => number} [opts.now] Injectable clock for stable
   *   timestamps in tests.
   * @param {{ debug?: Function, warn?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('SignalsAppender requires a numeric epicId');
    }
    if (typeof opts.appendEpicSignal !== 'function') {
      throw new TypeError(
        'SignalsAppender requires an appendEpicSignal function',
      );
    }
    this.epicId = opts.epicId;
    this._append = opts.appendEpicSignal;
    this._config = opts.config;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.logger = opts.logger ?? console;
    this._seen = new Set();
    this.events = Object.freeze([
      'story.dispatch.end',
      'story.blocked',
      'wave.end',
    ]);
  }

  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError('SignalsAppender.register requires a bus with on()');
    }
    return this.events.map((event) =>
      bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[SignalsAppender] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const signal = {
      kind: event,
      seqId,
      ts: new Date(this._now()).toISOString(),
      payload: { ...payload },
    };
    try {
      await this._append({
        epicId: this.epicId,
        signal,
        config: this._config,
      });
    } catch (err) {
      // Already best-effort inside `appendEpicSignal`, but guard
      // anyway so a misbehaving injected writer can't poison the
      // wave loop.
      this.logger.warn?.(
        `[SignalsAppender] append ${event}:${seqId} failed: ${err?.message ?? err}`,
      );
    }
  }

  resetSeen() {
    this._seen.clear();
  }
}

export function createSignalsAppender(opts) {
  return new SignalsAppender(opts);
}
