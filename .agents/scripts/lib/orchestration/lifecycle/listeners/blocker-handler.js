// .agents/scripts/lib/orchestration/lifecycle/listeners/blocker-handler.js
/**
 * BlockerHandler — lifecycle listener that cascades `story.blocked`
 * into `epic.blocked` (with `sourceStoryId`) and, when the operator
 * resumes, emits `epic.unblocked`.
 *
 * Subscribes to:
 *   - `story.blocked` → classify and (when the failure cascades) emit
 *                       `epic.blocked` carrying the originating
 *                       `sourceStoryId` and reason.
 *
 * Side effects produced *by other listeners* downstream of the emit:
 *   - LabelTransitioner flips the Epic ticket to `agent::blocked` on
 *     `epic.blocked` (and back to `agent::executing` on `epic.unblocked`).
 *   - StructuredCommentPoster posts the `lifecycle-epic-blocked` marker.
 *   - NotifyDispatcher fires the `epic-blocked` webhook envelope.
 *
 * The listener does NOT do any of those side effects itself — its
 * responsibility is purely classification + cascade emission, satisfying
 * the Tech Spec's "listener as classifier" contract (Story #2241 /
 * Task #2246).
 *
 * Operator interaction (the runtime pause point — the wait-for-resume
 * loop — remains in `epic-runner/phases/iterate-waves.js`) calls
 * `emitUnblocked(info)` on this instance once the Epic label is back
 * to `agent::executing`. The listener exposes that as a one-shot
 * method so the iterate-waves phase does not need to import the bus
 * directly.
 *
 * Idempotency contract (Acceptance Spec AC-9 + AC-10):
 *   - Every `story.blocked` received yields exactly one classification
 *     entry (`emitted`, `skipped`, or `failed`) — AC-9, no silent skip.
 *   - A repeat invocation with the same `(event, seqId)` short-circuits
 *     and is recorded as `skipped` with `reason: 'duplicate-seqId'`.
 *     The listener emits the cascade `epic.blocked` at most once per
 *     unique `(event, seqId)` — AC-10, listener idempotency.
 *   - `emitUnblocked` is idempotent within a recovery cycle: a second
 *     call before another `story.blocked` arrives is a no-op.
 */

/**
 * Classify a `story.blocked` payload into a cascade decision. Pure
 * function so unit tests can drive every branch without a bus
 * instance.
 *
 * Returns one of:
 *   - `{ outcome: 'cascade', reason, sourceStoryId }` — emit
 *     `epic.blocked` carrying these fields.
 *   - `{ outcome: 'skipped', reason }` — explicitly classify as
 *     "no cascade"; recorded in the classification log for AC-9
 *     traceability.
 *   - `{ outcome: 'failed', reason }` — the payload is malformed
 *     (e.g. missing `storyId`); the listener records the failure
 *     and re-throws so the bus's `onFailed` boundary persists the
 *     ledger record. Currently every well-formed `story.blocked`
 *     cascades; the `skipped` branch is reserved for future
 *     classifier extensions (e.g. `reason: 'transient-retry'`)
 *     that should not cascade.
 *
 * @param {object|null|undefined} payload
 * @returns {{ outcome: 'cascade', reason: string, sourceStoryId: number } | { outcome: 'skipped', reason: string } | { outcome: 'failed', reason: string }}
 */
export function classifyStoryBlocked(payload) {
  if (!payload || typeof payload !== 'object') {
    return { outcome: 'failed', reason: 'invalid-payload' };
  }
  const storyId = Number(payload.storyId);
  if (!Number.isInteger(storyId) || storyId < 1) {
    return { outcome: 'failed', reason: 'missing-storyId' };
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  if (reason.length === 0) {
    return { outcome: 'failed', reason: 'missing-reason' };
  }
  // Future-extension hook: classifier returns 'skipped' for reasons
  // operators have flagged as transient. Today every blocked Story
  // cascades, but the surface exists so AC-9 stays a contract not a
  // hardcoded constant.
  return { outcome: 'cascade', reason, sourceStoryId: storyId };
}

/**
 * BlockerHandler — instantiate one per Epic run and register on the
 * bus. Carries no per-run state besides the idempotency `Set` (so two
 * runs of the same Epic on different processes are independent — the
 * resume contract is owned by the ledger writer, not this listener).
 */
export class BlockerHandler {
  /**
   * @param {object} opts
   * @param {object} opts.bus Lifecycle bus instance (must expose
   *   `on()` and `emit()`).
   * @param {number} opts.epicId Epic ticket id. Surfaced into log
   *   lines and used to scope `epic.unblocked` emits.
   * @param {{ warn?: Function, info?: Function, debug?: Function }} [opts.logger]
   *   Optional logger; defaults to `console`.
   */
  constructor(opts = {}) {
    if (!opts.bus || typeof opts.bus.on !== 'function' || typeof opts.bus.emit !== 'function') {
      throw new TypeError('BlockerHandler requires a bus with on() and emit()');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('BlockerHandler requires a numeric epicId');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` keys we've handled. */
    this._seen = new Set();
    /**
     * Last cascade emitted within the current recovery cycle. Cleared
     * by `emitUnblocked()` so the next `story.blocked` cycle starts
     * fresh. Used to suppress duplicate `epic.unblocked` emits when an
     * operator flap-resumes the Epic before another blocker arrives.
     *
     * @type {{ reason: string, sourceStoryId: number } | null}
     */
    this._activeCascade = null;
    /**
     * Classification log — AC-9 "no silent skip" surface. Each
     * `story.blocked` we observe lands here with its outcome so tests
     * (and operators inspecting the listener) can confirm every
     * blocked Story was classified.
     *
     * @type {Array<{ event: string, seqId: number, storyId: number|null, outcome: string, reason: string }>}
     */
    this.classifications = [];
    /**
     * Subscribed events — exposed so callers/tests can verify the
     * listener registered on the right surface without grepping.
     */
    this.events = Object.freeze(['story.blocked']);
  }

  /**
   * Register this listener on the supplied bus. Returns an array of
   * unsubscribe functions (one per event) so tests can tear down
   * cleanly.
   *
   * The listener is registered on the same bus passed at construction.
   * Tests that want to drive `handle()` directly may skip registration
   * entirely.
   */
  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  /**
   * Bus listener body. The bus passes `{ event, seqId, payload }` per
   * its contract. Side effects:
   *   - Records a classification entry in `this.classifications`.
   *   - Emits `epic.blocked` on the bus when the classification is
   *     `cascade`. The emit is awaited so any listener exception
   *     propagates to the originating `story.blocked` emit's failed
   *     boundary, matching the bus's sequential-await contract.
   *
   * @param {{ event: string, seqId: number, payload: object }} ctx
   */
  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      // AC-10 — listener idempotency: a repeat (event, seqId) MUST NOT
      // re-emit `epic.blocked`. Record the skip so the AC-9
      // classification surface stays "no silent skip".
      this.classifications.push({
        event,
        seqId,
        storyId: Number(payload?.storyId) || null,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(
        `[BlockerHandler] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const classification = classifyStoryBlocked(payload);
    this.classifications.push({
      event,
      seqId,
      storyId: Number(payload?.storyId) || null,
      outcome: classification.outcome,
      reason: classification.reason,
    });

    if (classification.outcome === 'failed') {
      // Malformed payload — log and short-circuit. The bus's schema
      // validation should have caught this before us, so reaching
      // here means a future refactor relaxed the schema. We do NOT
      // throw because the bus's failed boundary already persisted
      // the originating story.blocked record; throwing would
      // double-fault the ledger.
      this.logger.warn?.(
        `[BlockerHandler] story.blocked classification failed for seqId=${seqId}: ${classification.reason}`,
      );
      return;
    }

    if (classification.outcome === 'skipped') {
      // Explicit "no cascade" classification — AC-9 surfaces this so
      // operators can see why a particular story.blocked did not
      // cascade to the Epic. Today there is no production code path
      // that yields `skipped`; tests exercise it via a stubbed
      // classifier.
      this.logger.info?.(
        `[BlockerHandler] story.blocked seqId=${seqId} story=#${payload?.storyId} classified skipped: ${classification.reason}`,
      );
      return;
    }

    // Cascade — emit `epic.blocked` carrying the typed reason and
    // sourceStoryId. The downstream LabelTransitioner +
    // StructuredCommentPoster + NotifyDispatcher listeners pick this
    // up and produce the original BlockerHandler side effects (label
    // flip + structured comment + webhook).
    this._activeCascade = {
      reason: classification.reason,
      sourceStoryId: classification.sourceStoryId,
    };
    try {
      await this.bus.emit('epic.blocked', {
        reason: classification.reason,
        sourceStoryId: classification.sourceStoryId,
      });
    } catch (err) {
      // The emit threw. Bus failure boundary already wrote a ledger
      // record (failed); roll back the active-cascade tracker so the
      // operator can retry. Surface to the logger but do not re-throw
      // — re-throwing would short-circuit OTHER listeners on the
      // originating story.blocked emit, which violates the
      // single-responsibility firewall.
      this._activeCascade = null;
      this.logger.warn?.(
        `[BlockerHandler] epic.blocked emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Emit `epic.unblocked` for the active cascade and clear the
   * recovery-cycle tracker. Idempotent: a second call before another
   * `story.blocked` arrives is a no-op (returns
   * `{ emitted: false, reason: 'no-active-cascade' }`).
   *
   * Iterate-waves calls this after `pollUntil` observes the operator's
   * label flip from `agent::blocked` back to `agent::executing`. The
   * runtime pause point remains in iterate-waves; this method is the
   * single seam that lets the runtime announce the resume on the bus.
   *
   * @param {{ reason?: string, sourceStoryId?: number }} [override]
   *   Optional override fields. When omitted the helper reuses the
   *   reason + sourceStoryId from the active cascade so the
   *   `epic.unblocked` record mirrors its matching `epic.blocked`.
   * @returns {Promise<{ emitted: boolean, reason?: string, sourceStoryId?: number }>}
   */
  async emitUnblocked(override = {}) {
    if (!this._activeCascade) {
      return { emitted: false, reason: 'no-active-cascade' };
    }
    const reason = override.reason ?? this._activeCascade.reason;
    const sourceStoryId =
      override.sourceStoryId ?? this._activeCascade.sourceStoryId;
    const payload = { reason };
    if (Number.isInteger(sourceStoryId) && sourceStoryId > 0) {
      payload.sourceStoryId = sourceStoryId;
    }
    try {
      await this.bus.emit('epic.unblocked', payload);
      this._activeCascade = null;
      return { emitted: true, ...payload };
    } catch (err) {
      this.logger.warn?.(
        `[BlockerHandler] epic.unblocked emit failed (swallowed): ${err?.message ?? err}`,
      );
      return { emitted: false, reason: `emit-failed:${err?.message ?? err}` };
    }
  }

  /**
   * Test helper — wipe the idempotency cache and active-cascade
   * tracker. Production code never calls this; tests use it to
   * simulate a fresh listener after a forced restart.
   */
  reset() {
    this._seen.clear();
    this._activeCascade = null;
    this.classifications = [];
  }
}

export function createBlockerHandler(opts) {
  return new BlockerHandler(opts);
}
