// .agents/scripts/lib/orchestration/wave-session.js
/**
 * WaveSession — deterministic dispatch primitive for `/epic-deliver`.
 *
 * Owns four responsibilities the host-LLM must NOT replicate inline:
 *
 *   1. **Cap** — never permit more than `cap` in-flight `dispatchFn`
 *      invocations at any moment.
 *   2. **Refill** — as soon as an in-flight slot resolves, dispatch the
 *      next eligible story from the wave's queue.
 *   3. **Await-all** — block `run()` until every story has settled.
 *   4. **Child-return parsing** — coerce the host-LLM's per-story return
 *      record into a typed outcome (`done | blocked | failed | skipped`),
 *      throwing a typed error on malformed payloads rather than silently
 *      defaulting.
 *
 * Bus emit ordering contract (Tech Spec § Wave-session primitive,
 * Acceptance Spec AC-13):
 *
 *   - `story.dispatch.start` is emitted in **submission order** — the
 *     order stories are handed to `dispatchFn`. Submission order matches
 *     the input `stories` array order because the queue is drained FIFO.
 *   - `story.dispatch.end` is emitted **serially through the bus**, one
 *     story at a time, regardless of the order in which `dispatchFn`
 *     promises settle. We use a single-flight emit lock so two concurrent
 *     settlements cannot interleave on the bus.
 *   - Ordering between waves is guaranteed (caller emits `wave.start` /
 *     `wave.end` around `run()`). Ordering between siblings *within* a
 *     wave is not guaranteed for `story.dispatch.end` — siblings settle
 *     in whatever order the child agents return.
 *
 * No `Promise.all` over listener arrays. The bus mediator under
 * `lib/orchestration/lifecycle/bus.js` is strictly sequential; wave-
 * session preserves that property end-to-end by serializing every
 * `bus.emit` call.
 */

const VALID_OUTCOMES = Object.freeze(['done', 'blocked', 'failed', 'skipped']);
const VALID_OUTCOMES_SET = new Set(VALID_OUTCOMES);

/**
 * Coerce a host-LLM child return record into the
 * `story.dispatch.end.outcome` enum. The runner accepts a permissive
 * surface (`status` or `outcome` field, plus a couple of legacy aliases)
 * so the host-LLM does not need to know the exact wire shape; this helper
 * normalizes once and rejects anything we cannot interpret.
 *
 * Accepted inputs:
 *   - `{ status: 'done' | 'blocked' | 'failed' | 'skipped', ... }`
 *   - `{ outcome: 'done' | 'blocked' | 'failed' | 'skipped', ... }`
 *   - `{ status: 'merged', ... }`  → `'done'` (legacy alias)
 *   - `{ status: 'timeout', ... }` → `'failed'` (legacy alias)
 *
 * Anything else throws a typed `Error` with `code: 'WAVE_MALFORMED_RETURN'`.
 *
 * @param {unknown} childReturn
 * @param {{ storyId: number }} ctx
 * @returns {'done' | 'blocked' | 'failed' | 'skipped'}
 */
export function parseChildReturn(childReturn, ctx) {
  const storyId = ctx?.storyId;
  if (childReturn === null || childReturn === undefined) {
    const err = new Error(
      `WaveSession: malformed child-return for story #${storyId}: value is ${childReturn === null ? 'null' : 'undefined'}`,
    );
    err.code = 'WAVE_MALFORMED_RETURN';
    err.storyId = storyId;
    throw err;
  }
  if (typeof childReturn !== 'object') {
    const err = new Error(
      `WaveSession: malformed child-return for story #${storyId}: expected object, got ${typeof childReturn}`,
    );
    err.code = 'WAVE_MALFORMED_RETURN';
    err.storyId = storyId;
    throw err;
  }
  const raw =
    typeof childReturn.outcome === 'string'
      ? childReturn.outcome
      : typeof childReturn.status === 'string'
        ? childReturn.status
        : null;
  if (raw === null) {
    const err = new Error(
      `WaveSession: malformed child-return for story #${storyId}: missing 'status' or 'outcome' string field`,
    );
    err.code = 'WAVE_MALFORMED_RETURN';
    err.storyId = storyId;
    throw err;
  }
  // Legacy aliases — `merged` lands when a Story closes cleanly, and
  // `timeout` is what the spawn layer surfaces when it kills a hung child.
  // Both predate the lifecycle taxonomy; coerce them rather than break
  // existing callers.
  let normalized = raw;
  if (raw === 'merged') normalized = 'done';
  else if (raw === 'timeout') normalized = 'failed';
  if (!VALID_OUTCOMES_SET.has(normalized)) {
    const err = new Error(
      `WaveSession: malformed child-return for story #${storyId}: outcome "${raw}" is not one of ${VALID_OUTCOMES.join(', ')}`,
    );
    err.code = 'WAVE_MALFORMED_RETURN';
    err.storyId = storyId;
    err.outcome = raw;
    throw err;
  }
  return normalized;
}

/**
 * Validate the `cap` argument. The runner config carries this as an
 * integer ≥ 1 (`orchestration.concurrencyCap` in `.agentrc.json`); we
 * defend at the primitive boundary so misconfiguration surfaces with a
 * useful error rather than a silent infinite-loop or zero-throughput run.
 */
function validateCap(cap) {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TypeError(
      `WaveSession: cap must be a positive integer, got ${String(cap)}`,
    );
  }
}

/**
 * Validate the `stories` argument. Empty waves are valid (the caller
 * still emits `wave.start` / `wave.end` around the call so the lifecycle
 * ledger carries the pair); we just resolve immediately.
 */
function validateStories(stories) {
  if (!Array.isArray(stories)) {
    throw new TypeError(
      `WaveSession: stories must be an array, got ${typeof stories}`,
    );
  }
  for (const story of stories) {
    if (!story || typeof story !== 'object') {
      throw new TypeError(
        `WaveSession: every story must be an object, got ${typeof story}`,
      );
    }
    if (!Number.isInteger(story.id) || story.id < 1) {
      throw new TypeError(
        `WaveSession: every story must carry an integer id ≥ 1, got ${String(story.id)}`,
      );
    }
  }
}

/**
 * WaveSession runs one wave of N stories with concurrency `cap`. One
 * instance is constructed per wave; constructing per-wave keeps the seqId
 * machinery on the bus the sole source of monotonicity and lets the
 * caller hold a per-wave `waveIndex` without threading it through
 * `run()`'s signature on every call.
 */
export class WaveSession {
  /**
   * @param {object} opts
   * @param {{ emit: (event: string, payload: object) => Promise<unknown> }} opts.bus
   *   Lifecycle bus instance. `emit()` is the only method we call.
   * @param {number} opts.waveIndex Zero-based wave index in the Epic's
   *   plan. Emitted on every `story.dispatch.start`.
   */
  constructor(opts) {
    if (!opts?.bus || typeof opts.bus.emit !== 'function') {
      throw new TypeError(
        'WaveSession: opts.bus must expose an emit(event, payload) method',
      );
    }
    if (!Number.isInteger(opts.waveIndex) || opts.waveIndex < 0) {
      throw new TypeError(
        `WaveSession: opts.waveIndex must be a non-negative integer, got ${String(opts.waveIndex)}`,
      );
    }
    this._bus = opts.bus;
    this._waveIndex = opts.waveIndex;
    // Injectable clock — `durationMs` on `story.dispatch.end` measures
    // wall-clock from submit to settle. Tests fake this for stable
    // assertions; production uses `Date.now`.
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    // Single-flight emit lock — every `bus.emit` call from this session
    // waits on the previous one's resolution so concurrent settlements
    // cannot interleave on the bus. The bus itself is already serial per
    // emit, but a concurrent caller could still race two `.emit()` calls;
    // this lock ensures we hand the bus one emit at a time.
    this._emitChain = Promise.resolve();
  }

  /**
   * Serialize a bus emit. Returns the same value bus.emit resolves with.
   *
   * Why a chained-lock instead of just `await bus.emit(...)` inside the
   * caller? Because `dispatchFn` may settle for two stories simultaneously
   * — both settlement handlers race to emit `story.dispatch.end`. Without
   * the chain, the order on the bus is decided by the JavaScript event
   * loop's promise microtask scheduling, which is technically deterministic
   * but not stable across Node versions or under load. The chain makes
   * "the next emit waits for the previous one" an explicit invariant.
   */
  _serialEmit(event, payload) {
    const next = this._emitChain.then(() => this._bus.emit(event, payload));
    // Swallow rejections on the chain itself so one failed emit doesn't
    // poison every subsequent emit. The caller awaits `next` and sees
    // the rejection there; the chain just needs to advance.
    this._emitChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Run one wave to completion.
   *
   * @param {object} args
   * @param {Array<{ id: number, [k: string]: unknown }>} args.stories
   *   Stories to dispatch, in submission order. Each story is passed to
   *   `dispatchFn` verbatim; only `id` is read by wave-session itself.
   * @param {(story: object) => Promise<object> | object} args.dispatchFn
   *   Hand-off to the host-LLM's Agent-tool fanout. Returns (or resolves
   *   to) a child-return record parsed by `parseChildReturn`.
   * @param {number} args.cap Concurrency cap. Never more than `cap`
   *   in-flight dispatches at any moment.
   * @returns {Promise<{
   *   waveIndex: number,
   *   outcomes: Record<number, 'done' | 'blocked' | 'failed' | 'skipped'>,
   *   returns: Record<number, object>,
   * }>}
   *   `outcomes` carries one entry per input story (covers exactly the
   *   `wave.start.storyIds` set per AC-8). `returns` carries the raw
   *   child-return records for downstream consumers (e.g. story.merged
   *   listener reads `sha`).
   */
  async run(args) {
    if (!args || typeof args !== 'object') {
      throw new TypeError('WaveSession.run: args must be an object');
    }
    const { stories, dispatchFn, cap } = args;
    validateStories(stories);
    validateCap(cap);
    if (typeof dispatchFn !== 'function') {
      throw new TypeError('WaveSession.run: dispatchFn must be a function');
    }
    /** @type {Record<number, string>} */
    const outcomes = {};
    /** @type {Record<number, object>} */
    const returns = {};
    if (stories.length === 0) {
      // Empty wave — no dispatch events, no work. Caller still owns
      // wave.start/wave.end so the lifecycle ledger carries the pair.
      return { waveIndex: this._waveIndex, outcomes, returns };
    }

    // FIFO queue of pending stories. We pop from the front so submission
    // order matches input order, satisfying the AC-13 requirement that
    // `story.dispatch.start` events appear in submission order.
    const queue = stories.slice();
    /** @type {Map<number, Promise<void>>} */
    const inFlight = new Map();

    const submitNext = async () => {
      if (queue.length === 0) return;
      const story = queue.shift();
      const submittedAt = this._now();
      // Emit start synchronously through the serial emit lock so two
      // concurrent submits cannot interleave start events on the bus.
      await this._serialEmit('story.dispatch.start', {
        storyId: story.id,
        waveIndex: this._waveIndex,
      });
      // Launch the child dispatch. Any throw is converted into a
      // typed `failed` outcome — the wave does not abort because one
      // child blew up. Operators see the failure on the per-story
      // dispatch.end record and the wave.end outcomes map.
      const settle = (async () => {
        let childReturn;
        let outcome;
        try {
          childReturn = await dispatchFn(story);
          outcome = parseChildReturn(childReturn, { storyId: story.id });
        } catch (err) {
          // Two failure modes:
          //   (a) dispatchFn itself threw — `childReturn` undefined.
          //   (b) parseChildReturn threw — `childReturn` carries the
          //       malformed payload.
          // Both surface as `failed` on the bus so the wave still
          // completes with a full outcomes map (AC-8 wave completeness).
          // The original error is attached to the recorded return so
          // downstream listeners and the lifecycle companion can render
          // it.
          outcome = 'failed';
          childReturn = {
            outcome: 'failed',
            error: {
              name: err?.name ? String(err.name) : 'Error',
              message: err?.message ? String(err.message) : String(err),
              code: err?.code,
            },
          };
        }
        outcomes[story.id] = outcome;
        returns[story.id] = childReturn;
        const durationMs = Math.max(0, this._now() - submittedAt);
        await this._serialEmit('story.dispatch.end', {
          storyId: story.id,
          outcome,
          durationMs,
        });
      })();
      inFlight.set(story.id, settle);
      // Refill is driven by each in-flight slot's settle: when this
      // promise resolves, drain one more from the queue.
      settle.finally(() => {
        inFlight.delete(story.id);
      });
    };

    // Prime the pump up to `cap` initial dispatches. We `await` each
    // start emit so submission order is preserved on the bus.
    const initialCount = Math.min(cap, queue.length);
    for (let i = 0; i < initialCount; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- submission ordering invariant
      await submitNext();
    }

    // Drain loop: each time any in-flight slot resolves, refill. We
    // race on `Promise.race(inFlight.values())` rather than `Promise.all`
    // so a single settle wakes us up to refill immediately (refill AC).
    // Promise.race is on dispatchFn settles, NOT on bus emits — the bus
    // remains strictly sequential.
    while (inFlight.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- refill primitive
      await Promise.race(Array.from(inFlight.values()));
      // After a race wakeup, refill until we hit cap or drain the queue.
      while (inFlight.size < cap && queue.length > 0) {
        // eslint-disable-next-line no-await-in-loop -- submission ordering
        await submitNext();
      }
    }

    return { waveIndex: this._waveIndex, outcomes, returns };
  }
}

/**
 * Factory wrapper for symmetry with `createBus()` / `createLedgerWriter()`.
 */
export function createWaveSession(opts) {
  return new WaveSession(opts);
}
