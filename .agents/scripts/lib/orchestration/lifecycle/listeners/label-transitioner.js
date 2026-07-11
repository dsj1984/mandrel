// .agents/scripts/lib/orchestration/lifecycle/listeners/label-transitioner.js
/**
 * LabelTransitioner — lifecycle listener that owns the terminal Epic
 * ticket-state flip: on `epic.complete` it transitions the Epic to
 * `agent::done` via the canonical `transitionTicketState` API (which
 * also closes the issue with `state_reason: completed` and mirrors the
 * Projects-v2 status column).
 *
 * Subscribes to:
 *   - `epic.complete` → and ONLY this event.
 *
 * Why this listener exists (regression history): the original
 * LabelTransitioner lived in the in-process epic-runner stratum and was
 * deleted with it (Story #3908 / #3936) — but the `lifecycle-emit`
 * listener chain never re-registered a replacement, so the Epic
 * `agent::done` flip silently had NO owner. Every docstring in
 * `cleaner.js` / `branch-cleaner.js` / `merge-watcher.js` that says
 * "LabelTransitioner flips the Epic ticket to `agent::done` on
 * epic.complete" referenced a ghost. In practice the flip only happened
 * when a driving session (or the operator) ran `update-ticket-state.js`
 * by hand — observed live on 2026-07-11 when Epics #4405 / #4425 /
 * #4429 merged cleanly (Cleaner archived, `epic.complete` on the
 * ledger) yet stayed at `agent::executing`. This listener restores the
 * documented contract on the SOLE production wiring path
 * (`buildDefaultListenerChain`).
 *
 * Side effects executed inside `handle()`:
 *   1. `transitionTicketState(provider, epicId, STATE_LABELS.DONE)` —
 *      adds `agent::done`, removes every other `agent::*` label, closes
 *      the issue as completed (idempotent when the GitHub Closes-#N
 *      linkage already closed it), syncs the board column, and runs the
 *      upward cascade (a no-op sweep here: story-close already flipped
 *      every child Story).
 *
 * Failure posture: a failed transition THROWS (per
 * `rules/orchestration-error-handling.md` — throw, never fatal). The
 * bus's `onFailed` hook records the failure on the ledger and
 * `lifecycle-emit`'s `collectOutcomes` → `emitBlockedSignal` path
 * surfaces it loudly, so a provider outage cannot silently strand the
 * Epic at `agent::executing` again — the exact failure mode this
 * listener exists to close.
 *
 * Idempotency contract: per-instance `Set<string>` of
 * `${event}:${seqId}` keys (the standard bus-replay defence). The
 * transition itself is also idempotent at the provider layer (label
 * add/remove and a close on an already-closed issue are no-ops), so a
 * cross-process replay after a crash re-runs the flip harmlessly.
 *
 * Side-effect firewall: exactly one provider call per handled event. No
 * filesystem writes, no follow-up bus emits, no `gh` shell-outs.
 */

import { STATE_LABELS } from '../../ticketing/reads.js';
import { transitionTicketState } from '../../ticketing/transition.js';

/**
 * The single lifecycle event this listener subscribes to. `epic.complete`
 * is the terminal event of a successful Epic run, emitted by Cleaner
 * AFTER the MergeWatcher observed a non-null mergeCommit — so the flip
 * can never fire for an Epic whose PR did not actually merge.
 */
export const SUBSCRIBED_EVENT = 'epic.complete';

export class LabelTransitioner {
  /**
   * @param {object} opts
   * @param {object} opts.bus Lifecycle bus exposing `on()`.
   * @param {number} opts.epicId Epic ticket id.
   * @param {import('../../../ITicketingProvider.js').ITicketingProvider} opts.provider
   *   Ticketing provider. Required — the chain builder skips this
   *   listener entirely when no provider is wired (parity with
   *   AutomergePredicate's guard), so construction can demand one.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (!opts.bus || typeof opts.bus.on !== 'function') {
      throw new TypeError('LabelTransitioner requires a bus with on()');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('LabelTransitioner requires a numeric epicId');
    }
    if (!opts.provider) {
      // Truthiness-only, parity with AutomergePredicate: the chain
      // builder's best-effort registration must not explode on a
      // shape-minimal provider — a malformed one fails loudly at
      // handle time instead, where the ledger records the outcome.
      throw new TypeError('LabelTransitioner requires a provider');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.provider = opts.provider;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    // Canonical subscription-set shape: the lifecycle doc-drift gate
    // (`check-lifecycle-doc-drift.js#extractCodeEvents`) and the
    // event-connectivity contract test both resolve this frozen array
    // (constant references included) to derive the subscriber table.
    this.events = Object.freeze([SUBSCRIBED_EVENT]);
  }

  /**
   * Register the listener on `epic.complete`. Returns the array of
   * unsubscribe callbacks the bus produced (parity with the sibling
   * listeners).
   */
  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  /**
   * Bus listener body. Idempotent on `(event, seqId)`; flips the Epic
   * to `agent::done` exactly once per observed `epic.complete`.
   */
  async handle({ event, seqId }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[LabelTransitioner] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    this.logger.info?.(
      `[LabelTransitioner] epic.complete observed — transitioning Epic #${this.epicId} to ${STATE_LABELS.DONE}.`,
    );
    // Throws on failure by design: the ledger records the failed
    // listener outcome and lifecycle-emit surfaces it (see the failure
    // posture note in the module docstring). Swallowing here would
    // recreate the silent agent::executing strand this listener fixes.
    await transitionTicketState(this.provider, this.epicId, STATE_LABELS.DONE);
  }

  /**
   * Test-only — clear the idempotency cache so a single instance can
   * exercise replay scenarios without re-constructing the listener.
   */
  resetSeen() {
    this._seen.clear();
  }
}
