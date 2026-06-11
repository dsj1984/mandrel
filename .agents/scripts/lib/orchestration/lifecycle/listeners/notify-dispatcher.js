// .agents/scripts/lib/orchestration/lifecycle/listeners/notify-dispatcher.js
/**
 * NotifyDispatcher — lifecycle listener that fans out the curated
 * webhook event subset (Story #2239 Task #2244).
 *
 * The framework's notification surface is the operator-supplied
 * `notifications.webhookEvents` allowlist (see
 * `.agents/scripts/lib/config/github.js NOTIFICATIONS_DEFAULTS`). Each
 * allowlisted name maps to one lifecycle event the bus emits — this
 * listener subscribes to those events and dispatches via the injected
 * `notify` function.
 *
 * Mapping (Tech Spec § curated webhooks):
 *
 *   webhookEvents entry    lifecycle event
 *   --------------------   ---------------------
 *   `epic-started`         (emitted at /deliver kickoff;
 *                          this listener handles `epic.snapshot.start`)
 *   `epic-blocked`         `epic.blocked`
 *   `epic-complete`        `epic.complete`
 *
 * The `epic-progress` and `epic-unblocked` webhook events are NOT mapped
 * here: their former dotted lifecycle triggers (`wave.end` /
 * `epic.unblocked`) belonged to the in-process runner stratum deleted in
 * Story #3908. The production wave loop fires those curated webhooks
 * directly through `progress-reporter/transport.js`
 * (`wave-record-notifications.js`), so the webhook names stay valid in
 * `NOTIFICATIONS_DEFAULTS` — only the redundant lifecycle-bus subscription
 * is gone.
 *
 * Why per-event subscriptions instead of a wildcard listener? The
 * wildcard would receive every event the bus carries, forcing the
 * dispatcher to re-check membership on every emit. Per-event
 * subscription gives the bus's mediator the routing decision once at
 * registration time and keeps the side-effect surface auditable.
 *
 * Idempotency: `(event, seqId)` guard short-circuits replays. The
 * `notify` function itself is fire-and-forget per `notify.js`
 * (failures are swallowed); the listener wraps in try/catch defense.
 *
 * Trace emit (Tech Spec § observability): for every event the
 * dispatcher handles, it appends a `notification.emitted` row to the
 * epic-level signals NDJSON via the injected `appendEpicSignal`. This
 * gives operators a single place to confirm that a webhook actually
 * fired (the `notify` function's success is silent). The trace row
 * also carries `seqId` so the resume test can prove
 * notifications survive a crash window without duplicating.
 */

/**
 * Static map: lifecycle event → curated webhook event name. Keys are
 * the bus event names this listener subscribes to.
 */
export const LIFECYCLE_TO_WEBHOOK_EVENT = Object.freeze({
  'epic.snapshot.start': 'epic-started',
  'epic.blocked': 'epic-blocked',
  'epic.complete': 'epic-complete',
});

/**
 * Compute the set of webhook event names this listener can emit.
 * Exposed so the listener-notify test can assert subset equality
 * against `notifications.webhookEvents` from `.agentrc.json`.
 */
export function webhookEventNames() {
  return new Set(Object.values(LIFECYCLE_TO_WEBHOOK_EVENT));
}

export class NotifyDispatcher {
  /**
   * @param {object} opts
   * @param {number} opts.epicId
   * @param {(ticketId: number, payload: object, opts?: object) => Promise<unknown>} opts.notify
   * @param {(args: object) => Promise<boolean>} [opts.appendEpicSignal]
   *   Optional trace writer; when omitted, trace emits are skipped.
   * @param {object} [opts.config] Resolved framework config (forwarded
   *   to `appendEpicSignal`).
   * @param {() => number} [opts.now]
   * @param {{ warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('NotifyDispatcher requires a numeric epicId');
    }
    if (typeof opts.notify !== 'function') {
      throw new TypeError('NotifyDispatcher requires a notify function');
    }
    this.epicId = opts.epicId;
    this._notify = opts.notify;
    this._appendEpicSignal = opts.appendEpicSignal ?? null;
    this._config = opts.config;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.logger = opts.logger ?? console;
    this._seen = new Set();
    this.events = Object.freeze(Object.keys(LIFECYCLE_TO_WEBHOOK_EVENT));
  }

  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError('NotifyDispatcher.register requires a bus with on()');
    }
    return this.events.map((event) =>
      bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[NotifyDispatcher] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const webhookEvent = LIFECYCLE_TO_WEBHOOK_EVENT[event];
    if (!webhookEvent) return;

    // notify() is fire-and-forget by contract; wrap in try/catch as a
    // defense layer so even a thrown notify error never propagates
    // back to the bus.
    try {
      await this._notify(
        this.epicId,
        {
          event: webhookEvent,
          level: 'epic',
          epicId: this.epicId,
          payload: { ...payload },
        },
        { skipComment: true },
      );
    } catch (err) {
      this.logger.warn?.(
        `[NotifyDispatcher] notify ${webhookEvent} failed: ${err?.message ?? err}`,
      );
    }

    // Self-emit `notification.emitted` for trace — but NOT through the
    // bus (the mediator forbids re-entry from inside a listener
    // body). Instead we append a row to the epic-level signals NDJSON
    // so the resume test can prove the dispatch survived a crash
    // window without duplicating.
    if (this._appendEpicSignal) {
      const signal = {
        kind: 'notification.emitted',
        seqId,
        ts: new Date(this._now()).toISOString(),
        sourceEvent: event,
        webhookEvent,
      };
      try {
        await this._appendEpicSignal({
          epicId: this.epicId,
          signal,
          config: this._config,
        });
      } catch {
        // already best-effort; swallow.
      }
    }
  }

  resetSeen() {
    this._seen.clear();
  }
}
