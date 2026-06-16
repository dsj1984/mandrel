// bench/report/persist.js
//
// Append-only scorecard store for the Mandrel self-benchmark harness
// (Epic #4211, Story #4218). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// The store is the durable substrate that makes "track the value-add over
// time" real: each run's per-run scorecards are appended — stamped with the
// pinned model, the framework version under test, and the execution
// environment — to a stable NDJSON ledger, so a later run can read them back
// and compare cohorts (bench/report/compare.js) without re-executing the
// expensive `claude -p` sessions.
//
// Why NDJSON and append-only:
//   - Append-only matches the harness's other ledgers (lifecycle.ndjson,
//     signals.ndjson) and is crash-safe: a partially-written final line never
//     corrupts the records before it.
//   - One JSON object per line is greppable, diffable, and streamable, and a
//     new run never has to rewrite history — it only appends.
//
// Every appended record is REQUIRED to carry the stamp fields (model.id,
// frameworkVersion, env.node, env.os) so the store can never hold an
// un-attributable scorecard that would later be compared across mismatched
// cohorts. A scorecard missing a stamp field is rejected at the boundary
// (fail loud, never persist silently-incomparable data).
//
// Determinism: the validation + serialization core is pure; only the public
// `appendScorecards` / `readStore` touch the filesystem, and both accept an
// injectable I/O shim so the core is unit-testable with no real disk.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { SCORECARD_SCHEMA_VERSION } from '../collect/normalize.js';

/**
 * The stamp fields every persisted scorecard MUST carry, each with an accessor
 * that pulls the value off a scorecard. A record missing any of these is
 * rejected — the store's whole point is that a later cross-run comparison only
 * compares like-to-like, which is impossible without a complete stamp.
 */
const REQUIRED_STAMP = Object.freeze([
  { key: 'runId', get: (sc) => sc?.runId },
  { key: 'model.id', get: (sc) => sc?.model?.id },
  { key: 'frameworkVersion', get: (sc) => sc?.frameworkVersion },
  { key: 'env.node', get: (sc) => sc?.env?.node },
  { key: 'env.os', get: (sc) => sc?.env?.os },
  { key: 'scenario', get: (sc) => sc?.scenario },
  { key: 'arm', get: (sc) => sc?.arm },
]);

/**
 * Validate that a scorecard carries the full stamp required to persist it.
 * Returns the list of missing field paths (empty ⇒ valid). Pure.
 *
 * @param {object} scorecard
 * @returns {string[]}  Missing stamp field paths.
 */
export function missingStampFields(scorecard) {
  if (!scorecard || typeof scorecard !== 'object') {
    return REQUIRED_STAMP.map((f) => f.key);
  }
  const missing = [];
  for (const { key, get } of REQUIRED_STAMP) {
    const v = get(scorecard);
    if (typeof v !== 'string' || v.length === 0) missing.push(key);
  }
  return missing;
}

/**
 * Derive the cohort key a scorecard belongs to — the tuple a cross-run
 * comparison groups by so it only ever compares like-to-like. Stable, so two
 * runs in the same cohort produce the identical key string.
 *
 * @param {object} scorecard
 * @returns {string}  `<model.id>|<frameworkVersion>|<env.node>|<env.os>`
 */
export function cohortKey(scorecard) {
  const model = scorecard?.model?.id ?? '';
  const fw = scorecard?.frameworkVersion ?? '';
  const node = scorecard?.env?.node ?? '';
  const os = scorecard?.env?.os ?? '';
  return `${model}|${fw}|${node}|${os}`;
}

/**
 * Serialize a list of scorecards to the NDJSON block that gets appended to the
 * store. Each record is validated for its stamp and schema version first; an
 * invalid record throws (the whole append is rejected — never persist a
 * partial, silently-incomparable batch). Pure — returns the string to append,
 * does no I/O.
 *
 * @param {Array<object>} scorecards
 * @returns {string}  NDJSON text ending in a single trailing newline.
 * @throws {TypeError}  When the input is not an array.
 * @throws {Error}      When any scorecard is missing stamp fields or carries an
 *                      unexpected schemaVersion.
 */
export function serializeScorecards(scorecards) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('serializeScorecards: scorecards must be an array');
  }
  const lines = [];
  for (let i = 0; i < scorecards.length; i += 1) {
    const sc = scorecards[i];
    const missing = missingStampFields(sc);
    if (missing.length > 0) {
      throw new Error(
        `serializeScorecards: scorecard[${i}] (runId=${sc?.runId ?? '?'}) is missing required stamp field(s): ${missing.join(', ')}`,
      );
    }
    if (
      sc.schemaVersion !== undefined &&
      sc.schemaVersion !== SCORECARD_SCHEMA_VERSION
    ) {
      throw new Error(
        `serializeScorecards: scorecard[${i}] (runId=${sc.runId}) has schemaVersion ${sc.schemaVersion}, expected ${SCORECARD_SCHEMA_VERSION}`,
      );
    }
    // Stamp the schema version on if the caller omitted it, so every persisted
    // record is self-describing.
    const record =
      sc.schemaVersion === undefined
        ? { schemaVersion: SCORECARD_SCHEMA_VERSION, ...sc }
        : sc;
    lines.push(JSON.stringify(record));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Parse the NDJSON store text back into scorecard records. Blank lines are
 * skipped; a malformed line throws with its 1-based line number so a corrupt
 * store fails loudly. Pure.
 *
 * @param {string} text
 * @returns {Array<object>}
 * @throws {SyntaxError}  On a non-blank line that is not valid JSON.
 */
export function parseStore(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseStore: input must be a string');
  }
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (cause) {
      throw new SyntaxError(
        `parseStore: invalid JSON on line ${i + 1}: ${cause.message}`,
      );
    }
  }
  return out;
}

/**
 * Append a batch of scorecards to the append-only store at `storePath`. Creates
 * the parent directory and the file on first write; never rewrites existing
 * records. Each scorecard is validated (full stamp + schema version) before any
 * byte is written, so a bad batch is rejected atomically rather than appending
 * a partial run.
 *
 * Idempotency note: appending is additive by design (a benchmark store is a
 * historical ledger — the same run re-appended is a duplicate the reader can
 * de-dup by `runId`, not an error). Callers that must avoid duplicates should
 * read the store and filter by `runId` first.
 *
 * @param {object} args
 * @param {string} args.storePath          Path to the NDJSON store file.
 * @param {Array<object>} args.scorecards  Scorecards to append.
 * @param {object} [deps]
 * @param {(p: string, data: string) => void} [deps.appendFileImpl]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string, opts: object) => void} [deps.mkdirImpl]
 * @returns {{ storePath: string, appended: number, bytesAppended: number }}
 */
export function appendScorecards({ storePath, scorecards }, deps = {}) {
  if (typeof storePath !== 'string' || storePath.length === 0) {
    throw new TypeError('appendScorecards: storePath is required');
  }
  const append = deps.appendFileImpl ?? appendFileSync;
  const exists = deps.existsImpl ?? existsSync;
  const mkdir = deps.mkdirImpl ?? mkdirSync;

  // Validate + serialize first; this throws before any I/O on a bad batch.
  const block = serializeScorecards(scorecards);
  if (block.length === 0) {
    return { storePath, appended: 0, bytesAppended: 0 };
  }

  const dir = dirname(storePath);
  if (dir && dir !== '.' && !exists(dir)) {
    mkdir(dir, { recursive: true });
  }

  append(storePath, block);
  return {
    storePath,
    appended: scorecards.length,
    bytesAppended: Buffer.byteLength(block, 'utf8'),
  };
}

/**
 * Read every scorecard from the store. A non-existent store reads as an empty
 * list (a store that was never written is simply empty, not an error).
 *
 * @param {object} args
 * @param {string} args.storePath
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {Array<object>}
 */
export function readStore({ storePath }, deps = {}) {
  if (typeof storePath !== 'string' || storePath.length === 0) {
    throw new TypeError('readStore: storePath is required');
  }
  const exists = deps.existsImpl ?? existsSync;
  const read = deps.readFileImpl ?? readFileSync;
  if (!exists(storePath)) return [];
  return parseStore(read(storePath, 'utf8'));
}

/**
 * Group the store's records by cohort key, preserving append order within each
 * cohort. The reader for the cross-run comparison slice — it lets a caller pull
 * "all runs for this (model, framework version, env)" out of a mixed store.
 *
 * @param {Array<object>} scorecards  Records read from the store.
 * @returns {Map<string, Array<object>>}
 */
export function groupByCohort(scorecards) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('groupByCohort: scorecards must be an array');
  }
  const byCohort = new Map();
  for (const sc of scorecards) {
    const key = cohortKey(sc);
    if (!byCohort.has(key)) byCohort.set(key, []);
    byCohort.get(key).push(sc);
  }
  return byCohort;
}
