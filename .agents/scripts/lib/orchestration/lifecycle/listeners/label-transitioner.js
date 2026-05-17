// .agents/scripts/lib/orchestration/lifecycle/listeners/label-transitioner.js
/**
 * LabelTransitioner — lifecycle listener that translates lifecycle
 * events into `agent::*` label transitions on the relevant ticket.
 *
 * Subscribes to (per Story #2239 Task #2242):
 *   - `wave.end`        → flip blocked/failed stories to `agent::blocked`
 *                         (done stories are flipped by story-close, not
 *                         by this listener).
 *   - `story.merged`    → flip the Story ticket to `agent::done`.
 *   - `story.blocked`   → flip the Story ticket to `agent::blocked`.
 *   - `epic.blocked`    → flip the Epic ticket to `agent::blocked`.
 *   - `epic.unblocked`  → flip the Epic ticket to `agent::executing`.
 *   - `epic.complete`   → flip the Epic ticket to `agent::done`.
 *
 * Idempotency contract (Acceptance Spec AC-10 — twice-invoked
 * listeners produce no duplicate label change):
 *   - The listener keeps a per-instance `Set<string>` of
 *     `event:seqId` keys it has handled. A repeat invocation with the
 *     same key short-circuits without calling `transitionTicketState`.
 *   - `transitionTicketState` is itself idempotent at the provider
 *     boundary (it diffs current labels before writing), so even if
 *     the seqId guard is bypassed (e.g. test fakes that share a Set
 *     across instances) a duplicate flip is a no-op at the API. The
 *     seqId guard is defense-in-depth that avoids the round-trip.
 *
 * Side-effect firewall: the listener calls `transitionTicketState`
 * only. It does NOT emit on the bus, does NOT mutate runner state,
 * and does NOT call `notify` (that's the notify-dispatcher
 * listener's job, Task #2244).
 */

import { STATE_LABELS } from '../../ticketing.js';

/**
 * Resolve the target state and ticket id for a given event payload.
 * Returns `null` when the event carries no actionable transition (e.g.
 * `wave.end` with zero blocked/failed stories), letting the listener
 * short-circuit silently.
 *
 * The wave.end path is special: a single event can transition multiple
 * Story tickets at once (one per blocked/failed entry in outcomes). The
 * caller handles the fan-out — `resolveTransition` returns the *list*
 * for wave.end and a single `{ ticketId, state }` record for all other
 * events.
 *
 * @param {string} event
 * @param {object} payload
 * @param {number|null} epicId
 * @returns {null | { ticketId: number, state: string } | { fanout: Array<{ ticketId: number, state: string }> }}
 */
export function resolveTransition(event, payload, epicId) {
  if (event === 'wave.end') {
    const outcomes = payload?.outcomes ?? {};
    const fanout = [];
    for (const [rawId, outcome] of Object.entries(outcomes)) {
      const ticketId = Number(rawId);
      if (!Number.isInteger(ticketId) || ticketId < 1) continue;
      if (outcome === 'blocked' || outcome === 'failed') {
        fanout.push({ ticketId, state: STATE_LABELS.BLOCKED });
      }
      // `done` and `skipped` are not transitioned here: `done` is owned
      // by `story-close.js` (which already flipped the ticket before
      // emitting `story.merged`); `skipped` represents a Story that was
      // already `agent::done` on resume.
    }
    return fanout.length ? { fanout } : null;
  }
  if (event === 'story.merged') {
    const ticketId = Number(payload?.storyId);
    if (!Number.isInteger(ticketId)) return null;
    return { ticketId, state: STATE_LABELS.DONE };
  }
  if (event === 'story.blocked') {
    const ticketId = Number(payload?.storyId);
    if (!Number.isInteger(ticketId)) return null;
    return { ticketId, state: STATE_LABELS.BLOCKED };
  }
  if (event === 'epic.blocked') {
    if (!Number.isInteger(epicId)) return null;
    return { ticketId: epicId, state: STATE_LABELS.BLOCKED };
  }
  if (event === 'epic.unblocked') {
    if (!Number.isInteger(epicId)) return null;
    return { ticketId: epicId, state: STATE_LABELS.EXECUTING };
  }
  if (event === 'epic.complete') {
    const ticketId = Number(payload?.epicId);
    if (!Number.isInteger(ticketId)) return null;
    return { ticketId, state: STATE_LABELS.DONE };
  }
  return null;
}

/**
 * LabelTransitioner — instantiate one per Epic run and register on
 * the bus.
 *
 * @param {object} opts
 * @param {object} opts.provider Ticketing provider (passed verbatim
 *   to `transitionTicketState`).
 * @param {number} opts.epicId Epic ticket id. Used to resolve the
 *   target ticket for `epic.*` events.
 * @param {(provider: object, ticketId: number, state: string, opts?: object) => Promise<unknown>} opts.transitionTicketState
 *   The state-writer dependency, injected so tests can fake the
 *   provider side without monkey-patching.
 * @param {{ warn?: Function, info?: Function, debug?: Function }} [opts.logger]
 *   Optional logger. Defaults to `console`.
 */
export class LabelTransitioner {
  constructor(opts = {}) {
    if (!opts.provider) {
      throw new TypeError('LabelTransitioner requires a provider');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('LabelTransitioner requires a numeric epicId');
    }
    if (typeof opts.transitionTicketState !== 'function') {
      throw new TypeError(
        'LabelTransitioner requires a transitionTicketState function',
      );
    }
    this.provider = opts.provider;
    this.epicId = opts.epicId;
    this._transition = opts.transitionTicketState;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` keys we've handled. */
    this._seen = new Set();
    /**
     * Subscribed events — exposed so callers (and tests) can verify
     * the listener registered on the right surface without grepping
     * the source.
     */
    this.events = Object.freeze([
      'wave.end',
      'story.merged',
      'story.blocked',
      'epic.blocked',
      'epic.unblocked',
      'epic.complete',
    ]);
  }

  /**
   * Register this listener on the given bus. Returns an array of
   * unsubscribe functions (one per event) so tests can tear down
   * cleanly.
   */
  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError(
        'LabelTransitioner.register requires a bus with on()',
      );
    }
    return this.events.map((event) =>
      bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  /**
   * Bus listener body. The bus passes `{ event, seqId, payload }` per
   * its contract. Idempotency: short-circuit on repeat `(event,seqId)`.
   */
  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[LabelTransitioner] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const resolved = resolveTransition(event, payload, this.epicId);
    if (!resolved) return;

    const targets = 'fanout' in resolved ? resolved.fanout : [resolved];
    for (const { ticketId, state } of targets) {
      try {
        await this._transition(this.provider, ticketId, state);
      } catch (err) {
        // Don't propagate — a label flip failure must not crash the
        // wave loop. Surface to logger and the bus's onFailed hook
        // (which the runner will register a stderr write on).
        this.logger.warn?.(
          `[LabelTransitioner] transition #${ticketId} → ${state} failed for ${event}: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Test helper — wipe the idempotency cache. Production code never
   * calls this; tests use it to simulate a resume scenario where the
   * cache is cold but the ledger says the seqId was already handled.
   */
  resetSeen() {
    this._seen.clear();
  }
}

export function createLabelTransitioner(opts) {
  return new LabelTransitioner(opts);
}
