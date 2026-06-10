// .agents/scripts/lib/orchestration/lifecycle/listeners/checkpoint-pointer-writer.js
/**
 * CheckpointPointerWriter — lifecycle listener that maintains a
 * minimal pointer file at `temp/epic-<id>/checkpoint.json` after every
 * `*.end` lifecycle event (Story #2266 / Task #2268, Epic #2172).
 *
 * The writer replaces the legacy `epic-runner/checkpointer.js`
 * structured-comment checkpointer with a ledger-driven pointer: the
 * NDJSON ledger (`lifecycle.ndjson`) is the canonical run history, and
 * the pointer file is a tiny `{ lastCompletedSeqId, phase }` snapshot
 * the runner reads at resume time to seek the right offset into the
 * ledger.
 *
 * Subscription set: **every event whose name ends in `.end`**. The
 * frozen `EVENTS` tuple is computed from the lifecycle schema directory
 * via the helper export so the registration cannot drift from the
 * taxonomy without updating the schema set.
 *
 * Self-emit contract: after the pointer write succeeds the listener
 * emits `checkpoint.written` exactly once per observed `*.end`. The
 * self-emit is guarded by the per-instance `(event, seqId)` idempotency
 * set so the bus's resume window (re-emitting an event whose `emitted`
 * line landed but whose `completed` did not) cannot produce a duplicate
 * `checkpoint.written`. The seqId set persists for the lifetime of the
 * listener; cross-process restart relies on the on-disk pointer's
 * monotonicity (the second invocation observes `lastCompletedSeqId >=
 * payload.seqId` and short-circuits).
 *
 * Side-effect firewall: filesystem write + exactly one `bus.emit`. No
 * provider calls, no GitHub IO, no runner-state mutation.
 *
 * Registration order: the runner factory registers this listener
 * EARLY — before downstream listeners that may fail — so the pointer
 * file always advances even if a later listener throws on the SAME
 * `*.end`. The throw still flows through the bus's `onFailed` hook
 * (LedgerWriter records a `failed` line) but the pointer reflects the
 * last `*.end` that reached this listener, which is what the resume
 * coordinator needs to skip past completed events on the next start.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The pointer file name under `temp/epic-<id>/`. Stable and grep-able
 * so future tooling can locate the file without re-deriving the path.
 */
export const POINTER_FILENAME = 'checkpoint.json';

/**
 * The self-emitted lifecycle event name. Matches the schema id at
 * `.agents/schemas/lifecycle/checkpoint.written.schema.json`.
 */
export const CHECKPOINT_WRITTEN_EVENT = 'checkpoint.written';

/**
 * The frozen list of `*.end` events the writer subscribes to. Sourced
 * from the lifecycle taxonomy (`.agents/schemas/lifecycle/*.end.schema.json`).
 *
 * Listed explicitly rather than discovered at runtime so:
 *   (a) the registration set is a code-visible contract — adding a new
 *       `*.end` event to the schema set forces a code change here,
 *       which is the seam reviewers grep for;
 *   (b) construction stays synchronous (no readdir + parse) and the
 *       constructor remains safe to call inside the runner factory.
 *
 * If a new `*.end` event is added to the schema directory, append it
 * here. The `checkpoint.written` event itself is intentionally NOT in
 * this list — the writer's own self-emit must not retrigger the writer
 * (that would loop), and `checkpoint.written` is not an `*.end` event
 * by naming convention.
 */
export const SUBSCRIBED_END_EVENTS = Object.freeze([
  'close-validate.end',
  'code-review.end',
  'epic.automerge.end',
  'epic.cleanup.end',
  'epic.close.end',
  'epic.finalize.end',
  'epic.plan.end',
  'epic.snapshot.end',
  'epic.watch.end',
  'retro.end',
  'story.dispatch.end',
]);

/**
 * Resolve the pointer-file path for a given Epic. Exported so tests
 * can target the same file without re-deriving the layout.
 */
export function resolvePointerPath({ tempRoot, epicId }) {
  if (typeof tempRoot !== 'string' || tempRoot.length === 0) {
    throw new TypeError(
      'resolvePointerPath: tempRoot must be a non-empty string',
    );
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError(
      'resolvePointerPath: epicId must be a positive integer',
    );
  }
  return path.join(tempRoot, `epic-${epicId}`, POINTER_FILENAME);
}

/**
 * Build the pointer payload. Pulled out so tests can assert the exact
 * on-disk shape without parsing JSON every time.
 */
export function buildPointerPayload({ lastCompletedSeqId, phase }) {
  return {
    lastCompletedSeqId,
    phase,
  };
}

/**
 * CheckpointPointerWriter listener.
 */
export class CheckpointPointerWriter {
  /**
   * @param {object} opts
   * @param {object} opts.bus Lifecycle bus exposing `on()` + `emit()`.
   * @param {number} opts.epicId Epic ticket id.
   * @param {string} opts.tempRoot Absolute or repo-relative path; the
   *   listener resolves `<tempRoot>/epic-<id>/checkpoint.json`.
   * @param {typeof writeFileSync} [opts.writeFn] Injectable writer for
   *   tests.
   * @param {typeof mkdirSync} [opts.mkdirFn] Injectable directory
   *   creator for tests.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError(
        'CheckpointPointerWriter requires a bus with on() and emit()',
      );
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('CheckpointPointerWriter requires a numeric epicId');
    }
    if (typeof opts.tempRoot !== 'string' || opts.tempRoot.length === 0) {
      throw new TypeError(
        'CheckpointPointerWriter requires a non-empty tempRoot string',
      );
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.tempRoot = opts.tempRoot;
    this._writeFn = opts.writeFn ?? writeFileSync;
    this._mkdirFn = opts.mkdirFn ?? mkdirSync;
    this.logger = opts.logger ?? console;
    this._pointerPath = resolvePointerPath({
      tempRoot: this.tempRoot,
      epicId: this.epicId,
    });
    this._epicDir = path.dirname(this._pointerPath);
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Monotonic seqId guard. The pointer's `lastCompletedSeqId` MUST
     * be non-decreasing — observing a lower seqId after a higher one
     * means we are replaying an out-of-order event (resume window or
     * test misuse). The listener short-circuits on the regression and
     * logs a debug line; it does NOT throw, because a resume cycle
     * can legitimately replay older `emitted` lines before catching
     * up.
     */
    this._lastSeqId = 0;
    this.events = SUBSCRIBED_END_EVENTS;
  }

  /**
   * Resolved on-disk path for the pointer file. Exposed for tests.
   */
  get pointerPath() {
    return this._pointerPath;
  }

  /**
   * Register the listener on every subscribed `*.end` event. Returns
   * the array of unsubscribe callbacks the bus produced (parity with
   * `signals-appender.register()`).
   */
  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  /**
   * Bus listener body. Idempotent on `(event, seqId)`; emits
   * `checkpoint.written` exactly once after the pointer write
   * succeeds.
   */
  async handle({ event, seqId, payload: _payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[CheckpointPointerWriter] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    // Resume / out-of-order guard. The on-disk pointer is the
    // canonical "highest seqId observed so far" — when a replay
    // delivers a seqId lower than what we already wrote, we keep the
    // pointer untouched and do NOT re-emit `checkpoint.written` for
    // the stale event. This makes the listener safe to register
    // BEFORE the resume coordinator has fully consumed the prior
    // ledger.
    if (seqId <= this._lastSeqId) {
      this.logger.debug?.(
        `[CheckpointPointerWriter] skip non-advancing seqId=${seqId} (lastCompletedSeqId=${this._lastSeqId})`,
      );
      return;
    }

    // The `phase` carried in the pointer is the event name itself —
    // every `*.end` event is by convention a phase boundary, so the
    // event name is the human-readable phase label the resume
    // coordinator displays ("we crashed after wave.end seqId=42").
    // Embedding the event name keeps the pointer self-describing
    // without requiring an extra `payload.phase` field on every
    // schema.
    const phase = event;
    const pointerPayload = buildPointerPayload({
      lastCompletedSeqId: seqId,
      phase,
    });

    try {
      this._mkdirFn(this._epicDir, { recursive: true });
      // `writeFileSync` with the default flag truncates — exactly
      // what we want: the pointer is a single-line atomic snapshot,
      // not an append log. The ledger is the append log; this file
      // is the cursor.
      this._writeFn(
        this._pointerPath,
        `${JSON.stringify(pointerPayload)}\n`,
        'utf8',
      );
    } catch (err) {
      // A failed pointer write is recoverable — the ledger still has
      // the full history, and the next `*.end` will retry the
      // pointer. Surface as a warning and bail before the self-emit
      // so we don't claim progress we didn't persist.
      this.logger.warn?.(
        `[CheckpointPointerWriter] pointer write failed for ${key}: ${err?.message ?? err}`,
      );
      // Leave the seqId guard advanced for this `(event, seqId)` so
      // the in-process retry path doesn't loop on the same failure,
      // but DO NOT bump `_lastSeqId` — the next event may still want
      // to advance past `seqId`.
      return;
    }
    this._lastSeqId = seqId;

    // Self-emit AFTER the pointer write succeeds. Per the listener
    // README, listeners MAY emit follow-up events; the seqId guard
    // above ensures `checkpoint.written` fires exactly once per
    // observed `*.end`.
    await this.bus.emit(CHECKPOINT_WRITTEN_EVENT, pointerPayload);
  }

  /**
   * Test-only — clear the seqId cache so a single instance can
   * exercise resume scenarios without re-constructing the listener.
   */
  resetSeen() {
    this._seen.clear();
    this._lastSeqId = 0;
  }
}
