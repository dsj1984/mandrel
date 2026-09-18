/**
 * CPU-pool worker for the native review: one file (a path, or
 * `{ source, label }` holding head content from `git show`) in, its full
 * maintainability report out. `report` is `null` only on an I/O error (the
 * file is dropped); a parse failure yields a `parseError` report, matching
 * the serial path.
 */

import { parentPort } from 'node:worker_threads';
import {
  calculateReport,
  calculateReportForFile,
} from '../maintainability-engine.js';
import { transpileIfNeeded } from '../transpile.js';
import { serveWorkerMessages } from './serve-worker-messages.js';

/**
 * Report for pre-sourced content; a failed transpile is a parse-error report.
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
 * Pure handler for one worker message (testable without a `Worker`).
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
    // A null report drops the file and keeps the run going.
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

serveWorkerMessages(parentPort, (msg) =>
  handleMaintainabilityReportWorkerMessage(msg),
);
