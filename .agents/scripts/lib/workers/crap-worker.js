/**
 * lib/workers/crap-worker.js — CPU-pool worker entry for `scanAndScore`.
 * One file in, the file's per-method CRAP rows out. No project config,
 * no git — just typhonjs-escomplex (via crap-engine), the in-memory TS
 * transpile shim, and the pure coverage-lookup helper.
 *
 * `workerData`:
 *   { coverage: object | null }   — the istanbul coverage map. Cloned
 *   into the worker once per spawn; lookups happen via the pure
 *   findCoverageEntry helper from coverage-utils.js.
 *
 * Message contract — see lib/cpu-pool.js:
 *   IN  : { item: { abs: string, relPath: string, requireCoverage: boolean } }
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
import { parentPort, workerData } from 'node:worker_threads';
import { findCoverageEntry } from '../coverage-utils.js';
import { calculateCrapForSource } from '../crap-engine.js';
import { transpileIfNeeded } from '../maintainability-utils.js';

if (!parentPort) {
  throw new Error('crap-worker.js must run inside a worker_threads Worker');
}

const coverage = workerData?.coverage ?? null;

parentPort.on('message', (msg) => {
  if (msg && msg.exit === true) {
    process.exit(0);
  }
  const item = msg?.item;
  if (
    !item ||
    typeof item.abs !== 'string' ||
    typeof item.relPath !== 'string'
  ) {
    parentPort.postMessage({
      ok: false,
      error: `bad worker message: ${JSON.stringify(msg)}`,
    });
    return;
  }
  const { abs, relPath, requireCoverage } = item;

  const entry = findCoverageEntry(coverage, relPath);
  if (requireCoverage && entry === null) {
    parentPort.postMessage({
      ok: true,
      result: {
        relPath,
        skippedFileNoCoverage: true,
        rows: [],
        skippedMethodsNoCoverage: 0,
      },
    });
    return;
  }

  let source;
  try {
    source = fs.readFileSync(abs, 'utf-8');
  } catch {
    parentPort.postMessage({
      ok: true,
      result: {
        relPath,
        skippedFileNoCoverage: false,
        rows: null,
        skippedMethodsNoCoverage: 0,
      },
    });
    return;
  }

  // TS/TSX → strip-then-analyze. Coverage lookup above used the original
  // source path (vitest's coverage-final.json keys on the .ts file, not
  // transpiled output); the transpile is purely about making the code
  // parseable by the Esprima-based escomplex kernel.
  const prepared = transpileIfNeeded(abs, source);
  if (prepared === null) {
    parentPort.postMessage({
      ok: true,
      result: {
        relPath,
        skippedFileNoCoverage: false,
        rows: null,
        skippedMethodsNoCoverage: 0,
      },
    });
    return;
  }

  let methodRows;
  try {
    methodRows = calculateCrapForSource(prepared, entry);
  } catch (err) {
    parentPort.postMessage({
      ok: true,
      result: {
        relPath,
        skippedFileNoCoverage: false,
        rows: null,
        skippedMethodsNoCoverage: 0,
        error:
          err && typeof err.message === 'string' ? err.message : String(err),
      },
    });
    return;
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
  parentPort.postMessage({
    ok: true,
    result: {
      relPath,
      skippedFileNoCoverage: false,
      rows,
      skippedMethodsNoCoverage,
    },
  });
});
