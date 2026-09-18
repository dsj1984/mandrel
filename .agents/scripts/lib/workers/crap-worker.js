/**
 * CPU-pool worker for `scanAndScore`: one file in, its per-method CRAP rows
 * out. The host pre-resolves each file's coverage entry (`item.coverageEntry`)
 * so the coverage map is never cloned per worker. An unrecoverable per-file
 * failure replies `rows: null`, which the host drops and counts.
 */

import { parentPort } from 'node:worker_threads';
import {
  calculateCrapForSource,
  finalizeMethodRows,
  UNSCORABLE,
} from '../crap-engine.js';
import { prepareSourceForScoring } from '../transpile.js';
import { serveWorkerMessages } from './serve-worker-messages.js';

/**
 * Pure handler for one worker message (testable without a `Worker`).
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

  const entry = item.coverageEntry ?? null;

  // One envelope for every non-error outcome, so drop and success shapes
  // cannot drift.
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

  // Coverage keys on original source lines; `prepared.mapLine` remaps
  // escomplex's transpiled coordinates to them.
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
  // Unparseable must drop (`rows: null`), not read as a file with no methods,
  // or its baseline rows vanish uncounted.
  if (methodRows === UNSCORABLE) return dropped(null);

  return reply(
    finalizeMethodRows(methodRows, { requireCoverage, coverageAvailable }),
  );
}

serveWorkerMessages(parentPort, (msg) => handleCrapWorkerMessage(msg, null));
