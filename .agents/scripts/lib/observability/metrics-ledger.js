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
import { Logger } from '../Logger.js';

export const PLAN_METRICS_BASENAME = 'plan-metrics.json';
export const PLAN_METRICS_SCHEMA_VERSION = 1;

/** Evidence for dropping a lens that stays at zero findings. */
const PLAN_METRICS_KIND_FINDINGS_YIELD = 'findings-yield';

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

/**
 * Append one findings-yield record. Never throws.
 *
 * @param {{
 *   storyId: number,
 *   lenses: Array<{ lens: string, findings?: number, skippedByFloor?: boolean }>,
 *   cli?: string,
 *   epicId?: number|null,
 *   diffFloor?: object|null,
 * }} entry
 * @param {object} [config]
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<boolean>} true when the line was written.
 */
export async function appendFindingsYield(entry, config, opts = {}) {
  try {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('appendFindingsYield requires an entry object');
    }
    const storyId = Number(entry.storyId);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      throw new TypeError(
        'appendFindingsYield requires a positive integer entry.storyId',
      );
    }
    if (!Array.isArray(entry.lenses) || entry.lenses.length === 0) {
      throw new TypeError(
        'appendFindingsYield requires a non-empty entry.lenses array',
      );
    }
    const epicId = entry.epicId ?? null;
    const record = {
      v: PLAN_METRICS_SCHEMA_VERSION,
      kind: PLAN_METRICS_KIND_FINDINGS_YIELD,
      cli:
        typeof entry.cli === 'string' && entry.cli.length > 0
          ? entry.cli
          : 'story-close-review',
      storyId,
      epicId,
      lenses: entry.lenses
        .filter((l) => l && typeof l.lens === 'string' && l.lens.length > 0)
        .map((l) => ({
          lens: l.lens,
          findings:
            typeof l.findings === 'number' && Number.isFinite(l.findings)
              ? l.findings
              : 0,
          skippedByFloor: l.skippedByFloor === true,
        })),
      diffFloor:
        entry.diffFloor && typeof entry.diffFloor === 'object'
          ? entry.diffFloor
          : null,
      at: new Date().toISOString(),
    };
    await appendLedgerRecord(record, {
      epicId,
      config,
      maxBytes: opts.maxBytes,
    });
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-metrics] findings-yield append failed (non-fatal): ${err?.message ?? err}`,
    );
    return false;
  }
}
