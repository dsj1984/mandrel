/**
 * CPU-pool worker for `calculateAll`: one file path in, one MI score out.
 * `score` is `null` only on an I/O error. An unanalysable file carries
 * `unscorable: true` and the kernel's `reason` (with `score: 0` for wire
 * compatibility) so the caller reports it instead of silently dropping it.
 */

import { parentPort } from 'node:worker_threads';
import { scoreFile } from '../maintainability-engine.js';
import { serveWorkerMessages } from './serve-worker-messages.js';

/**
 * Pure handler for one worker message (testable without a `Worker`).
 *
 * @param {unknown} msg
 * @param {{ score?: (filePath: string) => { score: number, unscorable: boolean, reason: string|null } }} [deps]
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
  const scoreFn = deps.score ?? scoreFile;
  try {
    // `scoreFn` returns `{ score, unscorable, reason }` — spread so the flag
    // and its reason reach the pool caller intact.
    return {
      kind: 'reply',
      message: { ok: true, result: { filePath, ...scoreFn(filePath) } },
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

serveWorkerMessages(parentPort, (msg) =>
  handleMaintainabilityWorkerMessage(msg),
);
