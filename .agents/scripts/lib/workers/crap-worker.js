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
 *                   coverageEntry: object | null } }
 *         { exit: true }
 *   OUT : { ok: true, result: {
 *           relPath,
 *           skippedFileNoCoverage: boolean,
 *           rows: Array<{ method, startLine, cyclomatic, coverage, crap }>,
 *           skippedMethodsNoCoverage: number,
 *         } }
 *
 * A truly unrecoverable per-file failure (read error, transpile null)
 * surfaces as `{ ok: true, result: { relPath, rows: null, ... } }` so
 * the host loop drops the file and increments its own counter — never
 * aborts the whole scan.
 */

import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { calculateCrapForSource } from '../crap-engine.js';
import { transpileIfNeeded } from '../transpile.js';

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
 * tests pass deterministic stubs.
 *
 * Coverage is supplied via `item.coverageEntry` (pre-resolved on the host),
 * not via a whole-map `coverage` argument. The second parameter is kept as
 * `_coverage` for backward-compatibility but is intentionally unused.
 *
 * @param {unknown} msg
 * @param {object|null} _coverage - Unused. Coverage is in `item.coverageEntry`.
 * @param {{
 *   readFile?: (abs: string) => string,
 *   transpile?: (abs: string, source: string) => string | null,
 *   calculateCrap?: (source: string, entry: object|null) => Array<object>,
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
  const { abs, relPath, requireCoverage } = item;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const transpile = deps.transpile ?? transpileIfNeeded;
  const calculateCrap = deps.calculateCrap ?? calculateCrapForSource;

  // Coverage entry is pre-resolved on the host and attached to the item.
  // `item.coverageEntry` may be explicitly `null` when the file has no
  // coverage, or `undefined` when the caller did not supply it (treat as null).
  const entry = item.coverageEntry ?? null;
  if (requireCoverage && entry === null) {
    return {
      kind: 'reply',
      message: {
        ok: true,
        result: {
          relPath,
          skippedFileNoCoverage: true,
          rows: [],
          skippedMethodsNoCoverage: 0,
        },
      },
    };
  }

  let source;
  try {
    source = readFile(abs);
  } catch {
    return {
      kind: 'reply',
      message: {
        ok: true,
        result: {
          relPath,
          skippedFileNoCoverage: false,
          rows: null,
          skippedMethodsNoCoverage: 0,
        },
      },
    };
  }

  // TS/TSX → strip-then-analyze. Coverage lookup above used the original
  // source path (vitest's coverage-final.json keys on the .ts file, not
  // transpiled output); the transpile is purely about making the code
  // parseable by the Esprima-based escomplex kernel.
  const prepared = transpile(abs, source);
  if (prepared === null) {
    return {
      kind: 'reply',
      message: {
        ok: true,
        result: {
          relPath,
          skippedFileNoCoverage: false,
          rows: null,
          skippedMethodsNoCoverage: 0,
        },
      },
    };
  }

  let methodRows;
  try {
    methodRows = calculateCrap(prepared, entry);
  } catch (err) {
    return {
      kind: 'reply',
      message: {
        ok: true,
        result: {
          relPath,
          skippedFileNoCoverage: false,
          rows: null,
          skippedMethodsNoCoverage: 0,
          error:
            err && typeof err.message === 'string' ? err.message : String(err),
        },
      },
    };
  }

  const rows = [];
  let skippedMethodsNoCoverage = 0;
  for (const mr of methodRows) {
    if (mr.crap === null || mr.coverage === null) {
      skippedMethodsNoCoverage += 1;
      continue;
    }
    rows.push({
      method: mr.method,
      startLine: mr.startLine,
      cyclomatic: mr.cyclomatic,
      coverage: mr.coverage,
      crap: mr.crap,
    });
  }
  return {
    kind: 'reply',
    message: {
      ok: true,
      result: {
        relPath,
        skippedFileNoCoverage: false,
        rows,
        skippedMethodsNoCoverage,
      },
    },
  };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    const out = handleCrapWorkerMessage(msg, null);
    if (out.kind === 'exit') {
      parentPort.close();
      return;
    }
    parentPort.postMessage(out.message);
  });
}
