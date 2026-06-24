/**
 * emit-loop-tick.js — Story #4287 (Epic #4284).
 *
 * Programmatic helper that emits a single `loop.tick` lifecycle event
 * THROUGH the lifecycle bus so a host-driven loop (e.g. a `/loop`-style
 * recurring command or a long-running poll) lands a per-pass record in
 * the on-disk ledger the `/deliver` idle watchdog already scans. The
 * record is what keeps a host loop from running silently: each round
 * appends an inspectable `emitted` line a reconciler can read for
 * forward-progress evidence.
 *
 * Distinct from `story.heartbeat` (emit-story-heartbeat.js): the
 * heartbeat carries Story-phase info for a single in-flight Story and is
 * always Epic-scoped (its ledger path is `epicLedgerPath(epicId)`). A
 * host loop is not bound to a Story tier, so `loop.tick` carries a
 * free-form `loopName`, a monotonic `round` counter, the loop's
 * configured `cadence` label, and a per-round `status` instead. Keeping
 * the two events separate means a loop tick never masquerades as Story
 * progress (and vice versa).
 *
 * Bus path (Story acceptance: "Emitting a loop.tick event THROUGH the
 * lifecycle bus appends a record to the per-run ledger"): this helper
 * constructs a `Bus`, registers a `LedgerWriter` against it, and calls
 * `bus.emit('loop.tick', payload)`. The bus validates the payload against
 * `loop.tick.schema.json` before any listener runs, and the
 * LedgerWriter's privileged `onEmitted` hook lands the `emitted` record
 * on disk — exactly the same persistence path every other lifecycle
 * event flows through. The helper does NOT bypass the bus with a direct
 * `appendFileSync`; routing through the bus is what gives the record its
 * schema-validated, seqId-stamped guarantee.
 *
 * Schema contract (loop.tick.schema.json):
 *   { event, loopName, round, cadence, status, timestamp }
 *
 * The schema declares `additionalProperties: false`, so this emitter's
 * signature is deliberately narrow: only the schema-allowed fields are
 * accepted. `status` is one of running|done|blocked.
 *
 * Ledger path resolution: a caller supplies EITHER an explicit
 * `ledgerPath` (the host-loop case — the loop owns where its ledger
 * lives) OR an `epicId`, in which case the canonical
 * `epicLedgerPath(epicId)` is used so an Epic-scoped loop's ticks land
 * in the same `temp/epic-<id>/lifecycle.ndjson` the rest of the run
 * reads. Exactly one of the two MUST be supplied.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { epicLedgerPath } from '../../config/temp-paths.js';
import { createBus } from './bus.js';
import { createLedgerWriter } from './ledger-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'lifecycle',
);

const VALID_STATUSES = new Set(['running', 'done', 'blocked']);

/**
 * Parse `temp/epic-<id>/lifecycle.ndjson` (or any
 * `<dir>/epic-<id>/lifecycle.ndjson`) back into `{ tempRoot, epicId }`
 * so a LedgerWriter — which is constructed from `{ epicId, tempRoot }`
 * rather than a raw path — can be bound to the supplied ledger path.
 *
 * The LedgerWriter intentionally re-derives the ledger path from its
 * `tempRoot` + `epicId` (so it can recreate the directory if a listener
 * moves it mid-run), so we decompose the path the caller gave us into
 * those two parts here.
 *
 * @param {string} ledgerPath
 * @returns {{ tempRoot: string, epicId: number }}
 */
function decomposeLedgerPath(ledgerPath) {
  const epicDir = path.dirname(ledgerPath);
  const tempRoot = path.dirname(epicDir);
  const epicDirName = path.basename(epicDir);
  const m = /^epic-(\d+)$/.exec(epicDirName);
  if (!m) {
    throw new Error(
      `emitLoopTick: ledgerPath does not match <tempRoot>/epic-<id>/lifecycle.ndjson layout (got ${ledgerPath})`,
    );
  }
  const epicId = Number.parseInt(m[1], 10);
  return { tempRoot, epicId };
}

/**
 * Emit exactly one `loop.tick` event through the lifecycle bus, landing
 * an `emitted` (and `completed`) NDJSON record in the resolved ledger.
 *
 * @param {object} opts
 * @param {string} opts.loopName     Free-form loop identifier (non-empty).
 * @param {number} opts.round        Monotonic pass counter (integer >= 0).
 * @param {string} opts.cadence      Configured interval label, e.g. '5m'.
 * @param {string} [opts.status='running']
 *                                   One of running|done|blocked.
 * @param {string} [opts.timestamp]  ISO-8601 wall clock. Defaults to now().
 * @param {number} [opts.epicId]     When supplied (and no `ledgerPath`),
 *                                   the canonical `epicLedgerPath(epicId)`
 *                                   is used for the ledger.
 * @param {object} [opts.config]     Optional resolved config for tempRoot
 *                                   (only consulted on the `epicId` path).
 * @param {string} [opts.ledgerPath] Explicit ledger path (host-loop case).
 *                                   Mutually exclusive with `epicId`.
 * @returns {Promise<{ ledgerPath: string, payload: object, seqId: number }>}
 */
export async function emitLoopTick(opts) {
  const {
    loopName,
    round,
    cadence,
    status = 'running',
    timestamp = new Date().toISOString(),
    epicId,
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};

  if (typeof loopName !== 'string' || loopName.length === 0) {
    throw new Error('emitLoopTick: loopName must be a non-empty string');
  }
  if (!Number.isInteger(round) || round < 0) {
    throw new Error('emitLoopTick: round must be a non-negative integer');
  }
  if (typeof cadence !== 'string' || cadence.length === 0) {
    throw new Error('emitLoopTick: cadence must be a non-empty string');
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(
      `emitLoopTick: status "${status}" must be one of: ${[...VALID_STATUSES].join(', ')}`,
    );
  }

  const hasEpicId = epicId !== undefined;
  const hasLedgerPath = ledgerPathOverride !== undefined;
  if (hasEpicId === hasLedgerPath) {
    throw new Error('emitLoopTick: supply exactly one of epicId or ledgerPath');
  }

  let ledgerPath;
  if (hasLedgerPath) {
    if (
      typeof ledgerPathOverride !== 'string' ||
      ledgerPathOverride.length === 0
    ) {
      throw new Error('emitLoopTick: ledgerPath must be a non-empty string');
    }
    ledgerPath = ledgerPathOverride;
  } else {
    if (!Number.isInteger(epicId) || epicId < 1) {
      throw new Error('emitLoopTick: epicId must be a positive integer');
    }
    ledgerPath = epicLedgerPath(epicId, config);
  }

  const payload = {
    event: 'loop.tick',
    loopName,
    round,
    cadence,
    status,
    timestamp,
  };

  // Route through the bus so the payload is schema-validated and the
  // LedgerWriter's privileged onEmitted hook persists the record — the
  // same path every lifecycle event flows through.
  const { tempRoot, epicId: ledgerEpicId } = decomposeLedgerPath(ledgerPath);
  const bus = createBus({ schemaDir: SCHEMA_DIR });
  const writer = createLedgerWriter({ epicId: ledgerEpicId, tempRoot });
  writer.register(bus);

  const { seqId } = await bus.emit('loop.tick', payload);
  return { ledgerPath: writer.ledgerPath, payload, seqId };
}
