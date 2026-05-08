/**
 * lib/workers/maintainability-worker.js — CPU-pool worker entry for
 * `calculateAll`. One file in, one score out. No project config, no git,
 * no provider — just typhonjs-escomplex (via maintainability-engine) and
 * the in-memory TS transpile shim.
 *
 * Message contract — see lib/cpu-pool.js:
 *   IN  : { item: string }      — absolute file path to score
 *         { exit: true }        — drain & terminate
 *   OUT : { ok: true, result: { filePath, score: number | null } }
 *
 * `score` is `null` only when the file genuinely cannot be read (ENOENT
 * or other I/O error). Parse failures inside escomplex still resolve to
 * `0` to preserve byte-for-byte parity with the pre-pool serial path
 * (calculateForSource swallows parse errors and returns 0).
 */

import { parentPort } from 'node:worker_threads';
import { calculateForFile } from '../maintainability-engine.js';

/**
 * Pure handler for a single inbound worker message. Exported so unit
 * tests can drive each branch (exit, malformed item, success, error)
 * without spawning a real `Worker` thread.
 *
 * @param {unknown} msg
 * @param {{ score?: (filePath: string) => number | null }} [deps]
 * @returns {{kind: 'exit'} | {kind: 'reply', message: object}}
 */
export function handleMaintainabilityWorkerMessage(msg, deps = {}) {
  if (msg && msg.exit === true) return { kind: 'exit' };

  if (!msg || typeof msg.item !== 'string') {
    return {
      kind: 'reply',
      message: {
        ok: false,
        error: `bad worker message: ${JSON.stringify(msg)}`,
      },
    };
  }
  const filePath = msg.item;
  const scoreFn = deps.score ?? calculateForFile;
  try {
    const score = scoreFn(filePath);
    return {
      kind: 'reply',
      message: { ok: true, result: { filePath, score } },
    };
  } catch (err) {
    // I/O or other unexpected error — surface as a per-item null score
    // so the run keeps going. The pool layer maps this to a missing
    // entry in the final scores map, matching the serial path's
    // existing "log-and-continue" behaviour.
    return {
      kind: 'reply',
      message: {
        ok: true,
        result: {
          filePath,
          score: null,
          error:
            err && typeof err.message === 'string' ? err.message : String(err),
        },
      },
    };
  }
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    const out = handleMaintainabilityWorkerMessage(msg);
    if (out.kind === 'exit') {
      parentPort.close();
      return;
    }
    parentPort.postMessage(out.message);
  });
}
