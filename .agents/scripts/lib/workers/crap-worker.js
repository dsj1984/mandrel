/**
 * lib/workers/crap-worker.js — CPU-pool worker entry for `scanAndScore`.
 * One file in, the file's per-method CRAP rows out. No project config,
 * no git — just typhonjs-escomplex (via crap-engine), the in-memory TS
 * transpile shim, and the pre-resolved coverage entry from the host.
 *
 * `workerData`: `{}` — coverage is no longer cloned into workers at spawn.
 * Instead, the host resolves each file's coverage entry via `findCoverageEntry`
 * before dispatch and attaches it as `item.coverageEntry`. Workers receive
 * only their file's entry, removing the O(workers × coverageMapSize) clone.
 *
 * Message contract — see lib/cpu-pool.js:
 *   IN  : { item: { abs: string, relPath: string, requireCoverage: boolean,
 *                   coverageAvailable?: boolean, coverageEntry: object | null } }
 *         { exit: true }
 *   OUT : { ok: true, result: {
 *           relPath,
 *           skippedFileNoCoverage: boolean,
 *           rows: Array<{ method, startLine, cyclomatic, coverage, crap }>,
 *           skippedMethodsNoCoverage: number,
 *           hasCoverageEntry: boolean,
 *           resolvedMethods: number,
 *           totalMethods: number,
 *         } }
 *
 * A truly unrecoverable per-file failure (read error, transpile null, or a
 * source the kernel cannot parse) surfaces as
 * `{ ok: true, result: { relPath, rows: null, ... } }` so the host loop drops
 * the file and increments its own counter — never aborts the whole scan.
 */

import { parentPort } from 'node:worker_threads';
import { calculateCrapForSource, finalizeMethodRows } from '../crap-engine.js';
import { prepareSourceForScoring } from '../transpile.js';
import { serveWorkerMessages } from './serve-worker-messages.js';

/**
 * Pure handler for a single inbound worker message. Exported so unit
 * tests can exercise every branch (bad-shape rejection, missing
 * coverage, fs/transpile/escomplex failures, success rows, skipped
 * methods) without spawning a real `Worker` thread.
 *
 * Returns one of:
 *   - `{ kind: 'exit' }`             — caller should close the port.
 *   - `{ kind: 'reply', message }`   — caller should `postMessage(message)`.
 *
 * Side effects (fs, transpile, escomplex) are wired through `deps` so
 * tests pass deterministic stubs. `readFile` / `transpile` are forwarded to
 * `prepareSourceForScoring`, which also derives the transpiled →
 * original-source line map the coverage join needs (Story #4775); a
 * `transpile` stub that still returns a bare string is tolerated.
 *
 * Coverage is supplied via `item.coverageEntry` (pre-resolved on the host),
 * not via a whole-map `coverage` argument. The second parameter is kept as
 * `_coverage` for backward-compatibility but is intentionally unused.
 *
 * @param {unknown} msg
 * @param {object|null} _coverage - Unused. Coverage is in `item.coverageEntry`.
 * @param {{
 *   readFile?: (abs: string) => string,
 *   transpile?: (abs: string, source: string, opts?: object) => unknown,
 *   prepare?: (abs: string, deps: object) => object,
 *   calculateCrap?: (source: string, entry: object|null, mapLine: Function|null) => Array<object>|null,
 * }} [deps]
 * @returns {{kind: 'exit'} | {kind: 'reply', message: object}}
 */
export function handleCrapWorkerMessage(msg, _coverage, deps = {}) {
  if (msg && msg.exit === true) return { kind: 'exit' };

  const item = msg?.item;
  if (
    !item ||
    typeof item.abs !== 'string' ||
    typeof item.relPath !== 'string'
  ) {
    return {
      kind: 'reply',
      message: {
        ok: false,
        error: `bad worker message: ${JSON.stringify(msg)}`,
      },
    };
  }
  const { abs, relPath, requireCoverage, coverageAvailable = true } = item;

  // Coverage entry is pre-resolved on the host and attached to the item.
  // `item.coverageEntry` may be explicitly `null` when the file has no
  // coverage, or `undefined` when the caller did not supply it (treat as null).
  const entry = item.coverageEntry ?? null;

  // Every non-error outcome answers in the same envelope; each branch below
  // overrides only the fields its own verdict changes. Spelling the seven
  // result fields out per branch is what let the drop shape and the success
  // shape drift apart in the first place.
  const reply = (result) => ({
    kind: 'reply',
    message: {
      ok: true,
      result: {
        relPath,
        skippedFileNoCoverage: false,
        rows: null,
        skippedMethodsNoCoverage: 0,
        hasCoverageEntry: entry !== null,
        resolvedMethods: 0,
        totalMethods: 0,
        ...result,
      },
    },
  });

  if (requireCoverage && entry === null) {
    return reply({ skippedFileNoCoverage: true, rows: [] });
  }

  const dropped = (error) => reply(error ? { error } : {});

  // TS/TSX -> transpile-then-analyze, carrying the source map. The coverage
  // lookup above used the ORIGINAL source path (vitest's coverage-final.json
  // keys on the .ts file, not transpiled output) and the per-method join
  // below uses ORIGINAL source *lines*, remapped from escomplex's transpiled
  // coordinates via `prepared.mapLine` (Story #4775).
  const prepare = deps.prepare ?? prepareSourceForScoring;
  const prepared = prepare(abs, deps);
  if (prepared.error) return dropped(null);

  let methodRows;
  try {
    methodRows = (deps.calculateCrap ?? calculateCrapForSource)(
      prepared.code,
      entry,
      prepared.mapLine,
    );
  } catch (err) {
    return dropped(
      err && typeof err.message === 'string' ? err.message : String(err),
    );
  }
  // Story #5311: the kernel returns `null` — not `[]` — for a source it could
  // not parse. Collapsing the two here is what made this drop path unreachable
  // for the whole parse-failure class: the file reached the host as a
  // successfully-scored file with no methods, and its baseline rows vanished
  // without a counter moving. `rows: null` is the serial path's `parseError`
  // verdict in the shape the host loop already drops on.
  if (methodRows === null) return dropped(null);

  return reply(
    finalizeMethodRows(methodRows, { requireCoverage, coverageAvailable }),
  );
}

serveWorkerMessages(parentPort, (msg) => handleCrapWorkerMessage(msg, null));
