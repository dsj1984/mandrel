/**
 * metrics-ledger.js — the one append tail for the plan-metrics ledger, kept
 * outside the plan domain so the close spine needn't import plan internals.
 * Public appenders are best-effort so capture never fails a phase or close.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  anchorTempRoot,
  runArtifactPath,
  tempRootFrom,
} from '../config/temp-paths.js';

export const PLAN_METRICS_BASENAME = 'plan-metrics.json';
export const PLAN_METRICS_SCHEMA_VERSION = 1;

/** Evidence for dropping a lens that stays at zero findings. */

/** ~5000 records; rotation only fires on pathological accumulation. */
export const MAX_LEDGER_BYTES = 1024 * 1024;

/**
 * `null` `epicId` → the standalone stream.
 *
 * @param {number|null} epicId
 * @param {object} [config]
 * @returns {string}
 */
export function planMetricsPath(epicId, config) {
  if (epicId === null || epicId === undefined) {
    return path.join(
      anchorTempRoot(tempRootFrom(config)),
      'standalone',
      PLAN_METRICS_BASENAME,
    );
  }
  return runArtifactPath(epicId, PLAN_METRICS_BASENAME, config);
}

/**
 * Roll over to `<file>.1` (replacing any prior) when the append would exceed
 * `maxBytes`.
 *
 * @param {string} filePath
 * @param {number} incomingBytes
 * @param {number} maxBytes
 * @returns {Promise<boolean>} true when a rotation happened.
 */
async function rotateIfNeeded(filePath, incomingBytes, maxBytes) {
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return false;
  }
  if (size + incomingBytes <= maxBytes) return false;
  await fs.rename(filePath, `${filePath}.1`);
  return true;
}

/**
 * Throws on fs failure; the wrapping public appenders own the best-effort
 * posture and label their own failure.
 *
 * @param {object} record
 * @param {{
 *   epicId?: number|null,
 *   config?: object,
 *   maxBytes?: number,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function appendLedgerRecord(record, opts = {}) {
  const filePath = planMetricsPath(opts.epicId ?? null, opts.config);
  const line = `${JSON.stringify(record)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await rotateIfNeeded(
    filePath,
    Buffer.byteLength(line),
    opts.maxBytes ?? MAX_LEDGER_BYTES,
  );
  await fs.appendFile(filePath, line, 'utf8');
}
