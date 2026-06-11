/**
 * lib/workers/maintainability-report-worker.js — CPU-pool worker entry for
 * the native ReviewProvider's per-file maintainability scoring. One file
 * in, the file's full maintainability *report* out (module score, per-method
 * scores, worstMethod). No project config, no git, no provider — just
 * typhonjs-escomplex (via maintainability-engine) and the in-memory TS
 * transpile shim.
 *
 * This is the report-shaped sibling of `maintainability-worker.js`, which
 * returns only the scalar MI score for the baseline gate. The native review
 * needs the richer report (per-method scores feed the critical/warning
 * tiering in `classifyReport`), so this worker calls
 * `calculateReportForFile` instead of `calculateForFile`.
 *
 * Message contract — see lib/cpu-pool.js:
 *   IN  : { item: string }                  — absolute file path to score
 *                                             (reads head content from disk)
 *         { item: { source, label } }       — pre-sourced content to score
 *                                             (Story #3696: the native review
 *                                             sources head content via
 *                                             `git show <headRef>:<path>` and
 *                                             passes the string here so the
 *                                             worker scores the head version,
 *                                             not the on-disk base copy)
 *         { exit: true }                     — drain & terminate
 *   OUT : { ok: true, result: { filePath, report: object | null } }
 *
 * `report` is `null` only when the file genuinely cannot be read (ENOENT
 * or other I/O error) — the native classifier treats a null report the
 * same way the serial path treats a thrown `reportFn` (drop the file).
 * Parse failures inside escomplex still resolve to a `{ parseError: true }`
 * report to preserve parity with the in-process serial path
 * (`calculateReportForFile` returns a parse-error report rather than
 * throwing).
 */

import { parentPort } from 'node:worker_threads';
import {
  calculateReport,
  calculateReportForFile,
} from '../maintainability-engine.js';
import { transpileIfNeeded } from '../transpile.js';

/**
 * Score a pre-sourced content string (Story #3696). Mirrors
 * `native.js#scoreSourceReport`: transpile the source by its `label`
 * extension, then report. A null transpile (unsupported / failed) resolves
 * to a parse-error report rather than throwing, matching the disk path.
 *
 * @param {string} source
 * @param {string} label  Path used only to pick the transpile mode.
 * @returns {object}
 */
function reportFromSource(source, label) {
  const prepared = transpileIfNeeded(label, source);
  if (prepared === null) {
    return {
      moduleScore: 0,
      methods: [],
      worstMethod: null,
      meanMethod: null,
      parseError: true,
    };
  }
  return calculateReport(prepared);
}

/**
 * Pure handler for a single inbound worker message. Exported so unit
 * tests can drive each branch (exit, malformed item, success, error)
 * without spawning a real `Worker` thread.
 *
 * @param {unknown} msg
 * @param {{ report?: (filePath: string) => object }} [deps]
 * @returns {{kind: 'exit'} | {kind: 'reply', message: object}}
 */
export function handleMaintainabilityReportWorkerMessage(msg, deps = {}) {
  if (msg && msg.exit === true) return { kind: 'exit' };

  const item = msg?.item;
  const isPathItem = typeof item === 'string';
  const isSourceItem =
    item &&
    typeof item === 'object' &&
    typeof item.source === 'string' &&
    typeof item.label === 'string';
  if (!isPathItem && !isSourceItem) {
    return {
      kind: 'reply',
      message: {
        ok: false,
        error: `bad worker message: ${JSON.stringify(msg)}`,
      },
    };
  }
  const filePath = isPathItem ? item : item.label;
  const reportFn = deps.report ?? calculateReportForFile;
  const sourceReportFn = deps.reportFromSource ?? reportFromSource;
  try {
    const report = isSourceItem
      ? sourceReportFn(item.source, item.label)
      : reportFn(filePath);
    return {
      kind: 'reply',
      message: { ok: true, result: { filePath, report } },
    };
  } catch (err) {
    // I/O or other unexpected error (e.g. file deleted between diff and
    // scoring) — surface as a per-item null report so the run keeps
    // going. The native classifier maps a null report to a dropped file,
    // matching the serial path's `classifyChangedFile` try/catch that
    // returns `{ row: null }` on a thrown reportFn.
    return {
      kind: 'reply',
      message: {
        ok: true,
        result: {
          filePath,
          report: null,
          error:
            err && typeof err.message === 'string' ? err.message : String(err),
        },
      },
    };
  }
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    const out = handleMaintainabilityReportWorkerMessage(msg);
    if (out.kind === 'exit') {
      parentPort.close();
      return;
    }
    parentPort.postMessage(out.message);
  });
}
