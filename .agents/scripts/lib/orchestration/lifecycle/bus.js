// .agents/scripts/lib/orchestration/lifecycle/bus.js
/**
 * Lifecycle event bus — sequential awaited mediator.
 *
 * The bus is the only authorized emitter of typed lifecycle events. It is a
 * mediator (not pub/sub): listeners run in registration order, awaited,
 * and a throw in any listener short-circuits the remaining listeners and
 * propagates to the caller. There is no Promise.all over listener arrays
 * — that pattern breaks repeatability and is forbidden by the lint rule in
 * `biome.json`.
 *
 * Wildcard subscriptions (`bus.on('*', fn)`) are permitted for trace /
 * heartbeat observers. They MUST NOT perform side effects on the system
 * under orchestration; the firewall against state-mutating imports in
 * wildcard listeners is documented in
 * `.agents/scripts/lib/orchestration/lifecycle/listeners/README.md`.
 *
 * Schema validation: `emit()` validates the payload against the schema at
 * `.agents/schemas/lifecycle/<event>.schema.json` BEFORE invoking any
 * listener. Validation failures throw immediately; no `emitted` ledger
 * record is written, no listener runs. This guarantees that every record
 * in the ledger carries a payload conformant to its event schema.
 *
 * The bus does NOT write the ledger directly. `LedgerWriter` registers as
 * the first listener on every event and handles persistence. This keeps
 * the bus a pure mediator and makes the ledger boundary easy to fake in
 * tests.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'lifecycle',
);

/**
 * Compile a validator for a single event by loading its schema lazily. The
 * result is cached per Bus instance so repeated emits of the same event
 * don't re-parse JSON.
 */
function buildValidator(ajv, schemaDir, event) {
  const schemaPath = path.join(schemaDir, `${event}.schema.json`);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  return ajv.compile(schema);
}

/**
 * Format AJV error array into a single-line message suitable for a thrown
 * Error. Reviewers prefer a compact summary over a stringified blob.
 */
function formatAjvErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'invalid payload';
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message}`.trim())
    .join('; ');
}

export class Bus {
  /**
   * @param {object} [opts]
   * @param {string} [opts.schemaDir] absolute path to the lifecycle schema
   *   directory. Defaults to `.agents/schemas/lifecycle/` resolved against
   *   this module's location. Tests pass a fixture directory.
   */
  constructor(opts = {}) {
    this._schemaDir = opts.schemaDir ?? DEFAULT_SCHEMA_DIR;
    this._ajv = new Ajv2020({ allErrors: true });
    addFormats(this._ajv);
    /** @type {Map<string, Array<{ fn: Function, wildcard: boolean }>>} */
    this._listeners = new Map();
    /** @type {Array<{ fn: Function, wildcard: boolean }>} */
    this._wildcards = [];
    /** @type {Map<string, Function>} cached AJV validators. */
    this._validators = new Map();
    this._nextSeqId = 1;
  }

  /**
   * Register a listener. Use `event === '*'` for a wildcard observer; the
   * `wildcard: true` flag is set on the listener record so the lint rule
   * (and downstream reviewers) can identify observer-only listeners.
   *
   * Returns an unsubscribe function for symmetry with conventional emitter
   * APIs; the runner doesn't currently use it, but tests do.
   */
  on(event, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Bus.on: listener must be a function');
    }
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('Bus.on: event must be a non-empty string');
    }
    const record = { fn, wildcard: event === '*' };
    if (event === '*') {
      this._wildcards.push(record);
      return () => {
        this._wildcards = this._wildcards.filter((r) => r !== record);
      };
    }
    const list = this._listeners.get(event) ?? [];
    list.push(record);
    this._listeners.set(event, list);
    return () => {
      const next = (this._listeners.get(event) ?? []).filter(
        (r) => r !== record,
      );
      if (next.length === 0) this._listeners.delete(event);
      else this._listeners.set(event, next);
    };
  }

  /**
   * Get (and cache) the compiled AJV validator for a given event.
   */
  _getValidator(event) {
    let validator = this._validators.get(event);
    if (!validator) {
      validator = buildValidator(this._ajv, this._schemaDir, event);
      this._validators.set(event, validator);
    }
    return validator;
  }

  /**
   * Emit a typed event.
   *
   * Contract (Tech Spec § Bus contract):
   *   1. validate payload (throw before any listener runs on mismatch);
   *   2. assign monotonic per-run seqId;
   *   3. invoke registered named listeners sequentially with await;
   *   4. invoke wildcard listeners sequentially with await AFTER named
   *      listeners (observer order);
   *   5. propagate the first thrown error.
   *
   * The bus does NOT write the ledger directly; LedgerWriter is wired in
   * by the runner as the first registered named listener for every event.
   *
   * @param {string} event
   * @param {object} payload
   * @returns {Promise<{ seqId: number }>}
   */
  async emit(event, payload) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('Bus.emit: event must be a non-empty string');
    }
    const validator = this._getValidator(event);
    const ok = validator(payload);
    if (!ok) {
      const err = new Error(
        `Bus.emit: schema validation failed for "${event}": ${formatAjvErrors(validator.errors)}`,
      );
      err.code = 'BUS_SCHEMA_VALIDATION';
      err.event = event;
      err.ajvErrors = validator.errors;
      throw err;
    }
    const seqId = this._nextSeqId;
    this._nextSeqId += 1;
    const context = { event, seqId, payload };
    const named = this._listeners.get(event) ?? [];
    for (const record of named) {
      await record.fn(context);
    }
    for (const record of this._wildcards) {
      await record.fn(context);
    }
    return { seqId };
  }

  /**
   * Inspect the next seqId without emitting. Useful for tests asserting
   * monotonicity across multiple bus instances or after replay.
   */
  peekNextSeqId() {
    return this._nextSeqId;
  }
}

/**
 * Convenience factory. Lets the runner own bus construction without
 * importing the class name directly.
 */
export function createBus(opts = {}) {
  return new Bus(opts);
}
