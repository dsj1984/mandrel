// .agents/scripts/lib/orchestration/lifecycle/ledger-writer.js
/**
 * LedgerWriter — append-only NDJSON persister for the lifecycle bus.
 *
 * Registered as the first named listener on every event by the runner
 * factory. Each successful emit produces exactly one `emitted` + one
 * `completed` line; a listener throw produces `emitted` + `failed`.
 *
 * The writer is a thin wrapper around `fs.appendFileSync` because:
 *   - the bus is strictly sequential, so a synchronous append cannot race;
 *   - resume semantics depend on the ledger being on disk before any
 *     downstream listener runs (`emitted` lands before listener `N`
 *     executes; a crash mid-listener leaves an `emitted`-without-
 *     `completed` line that resume detects);
 *   - synchronous I/O makes failure modes obvious (a thrown EACCES is
 *     observable immediately and propagates through the bus).
 *
 * Secret denylist: payload keys named in `SECRET_KEY_DENY_LIST` are
 * stripped before write. This is defense-in-depth: payloads should never
 * carry secrets to begin with, but the strip means a future contributor
 * who accidentally adds `{ token: ... }` to an event payload can't leak
 * it to the on-disk ledger (which we treat as an artifact safe to attach
 * to PR comments).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Static deny-list pulled from the Tech Spec § Security & Privacy. Keys
 * are matched case-insensitively against own enumerable keys of the
 * top-level payload AND of any nested object.
 */
export const SECRET_KEY_DENY_LIST = Object.freeze([
  'token',
  'password',
  'secret',
  'apikey',
  'webhookurl',
]);

const SECRET_DENY_SET = new Set(SECRET_KEY_DENY_LIST);

/**
 * Recursively strip deny-listed keys from an arbitrary value. Arrays and
 * primitives are passed through; objects produce a new object with the
 * deny-listed keys omitted. The original input is not mutated.
 *
 * Cyclic structures aren't expected in event payloads (the schema layer
 * forbids them by construction), so we don't carry a `seen` set.
 */
export function stripSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_DENY_SET.has(k.toLowerCase())) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Produce the canonical ISO-8601 wall-clock string for a ledger record.
 * Pulled out so tests can fake `Date.now()` without mocking the global.
 */
function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

/**
 * LedgerWriter binds to a single Epic's temp directory. The runner
 * constructs one per Epic run (and reuses it across resume).
 *
 * Usage:
 *   const writer = new LedgerWriter({ epicId: 2172, tempRoot: 'temp' });
 *   writer.register(bus);
 */
export class LedgerWriter {
  /**
   * @param {object} opts
   * @param {number} opts.epicId
   * @param {string} opts.tempRoot - absolute or repo-relative path; the
   *   writer resolves `temp/epic-<id>/lifecycle.ndjson` underneath.
   * @param {() => number} [opts.now] - injectable clock for tests.
   */
  constructor(opts) {
    if (!opts || !Number.isInteger(opts.epicId) || opts.epicId <= 0) {
      throw new TypeError(
        'LedgerWriter: opts.epicId must be a positive integer',
      );
    }
    if (typeof opts.tempRoot !== 'string' || opts.tempRoot.length === 0) {
      throw new TypeError(
        'LedgerWriter: opts.tempRoot must be a non-empty string',
      );
    }
    this._epicId = opts.epicId;
    this._tempRoot = opts.tempRoot;
    this._epicDir = path.join(this._tempRoot, `epic-${this._epicId}`);
    this._ledgerPath = path.join(this._epicDir, 'lifecycle.ndjson');
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
  }

  /**
   * Resolved on-disk path for the NDJSON ledger. Exposed for tests and
   * for the TraceLogger which renders the companion markdown from it.
   */
  get ledgerPath() {
    return this._ledgerPath;
  }

  /**
   * Directory housing the ledger and (later) the companion markdown.
   */
  get epicDir() {
    return this._epicDir;
  }

  /**
   * Ensure the epic-scoped temp directory exists before every append.
   *
   * The naive optimization (cache "ensured" after the first call) is
   * unsound when a listener moves the ledger directory mid-handler —
   * which is exactly what the Cleaner does on Wave 8 (Story #2259):
   * it renames `temp/epic-<id>/` under `archive/` between the listener
   * body and the bus's `onCompleted` hook fire-time, and the next
   * append (the `completed` record for the outer event) would land
   * in a vanished directory. `mkdirSync({recursive: true})` is
   * idempotent and cheap (microseconds), so we call it every time and
   * keep the writer robust to its own directory being moved.
   */
  _ensureDir() {
    mkdirSync(this._epicDir, { recursive: true });
  }

  /**
   * Append one NDJSON record. Internal — callers should use the bus
   * listener registered by `register()`.
   */
  _appendRecord(record) {
    this._ensureDir();
    appendFileSync(this._ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /**
   * Build the `emitted` record for a given context. Exposed for tests so
   * the deny-list strip can be asserted directly.
   */
  buildEmitted({ event, seqId, payload }) {
    return {
      kind: 'emitted',
      seqId,
      ts: nowIso(this._now),
      event,
      payload: stripSecrets(payload ?? {}),
    };
  }

  buildCompleted({ event, seqId }) {
    return {
      kind: 'completed',
      seqId,
      ts: nowIso(this._now),
      event,
    };
  }

  buildFailed({ event, seqId, listener, error }) {
    const errorRecord = {
      name: error?.name ? String(error.name) : 'Error',
      message: error?.message ? String(error.message) : String(error),
    };
    if (typeof error?.stack === 'string' && error.stack.length > 0) {
      errorRecord.stack = error.stack;
    }
    return {
      kind: 'failed',
      seqId,
      ts: nowIso(this._now),
      event,
      listener,
      error: errorRecord,
    };
  }

  /**
   * Register this writer against the supplied bus by installing the
   * privileged `onEmitted` / `onCompleted` / `onFailed` hooks. The
   * writer is NOT a regular listener — it uses the privileged seam so
   * `emitted` lands BEFORE any listener side effect (resume contract)
   * and `completed` / `failed` land AFTER the listener phase.
   */
  register(bus) {
    if (
      !bus ||
      typeof bus.onEmitted !== 'function' ||
      typeof bus.onCompleted !== 'function' ||
      typeof bus.onFailed !== 'function'
    ) {
      throw new TypeError(
        'LedgerWriter.register: bus must expose onEmitted/onCompleted/onFailed hooks',
      );
    }
    bus.onEmitted(({ event, seqId, payload }) => {
      this._appendRecord(this.buildEmitted({ event, seqId, payload }));
    });
    bus.onCompleted(({ event, seqId }) => {
      this._appendRecord(this.buildCompleted({ event, seqId }));
    });
    bus.onFailed(({ event, seqId, listener, error }) => {
      this._appendRecord(this.buildFailed({ event, seqId, listener, error }));
    });
  }
}

/**
 * Factory wrapper for symmetry with `createBus()`.
 */
export function createLedgerWriter(opts) {
  return new LedgerWriter(opts);
}
