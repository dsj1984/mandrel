/**
 * metrics-ledger.js — the narrow shared metrics-ledger boundary (Story #4712).
 *
 * Owns the one append-tail implementation for the plan-metrics ledger:
 * path resolution, serialization, lazy directory creation, size-capped
 * rotation, and the append itself. Every ledger writer — the plan-domain
 * appenders in `../orchestration/plan-metrics.js` and the close-domain
 * findings-yield entry point below — routes through
 * {@link appendLedgerRecord}, so the open→append→rotate→close tail exists
 * exactly once and cannot drift between call sites.
 *
 * The findings-yield entry point (Story #4699) lives here rather than in
 * the plan-domain module so the story-close review spine
 * (`../orchestration/story-close/phases/review-core.js`) depends on this
 * narrow shared ledger module instead of plan-domain internals.
 *
 * Wire contract (unchanged by the #4712 re-home): record shapes, file
 * locations (`temp/run-<id>/plan-metrics.json` / the standalone stream),
 * and the rotation threshold are exactly what `plan-metrics.js` shipped —
 * readers (`readPlanMetrics` / `summarizePlanMetrics`) stay plan-side and
 * key kinded records on `kind`, never on absent fields.
 *
 * Robustness contract (mirrors `signals-writer.js`):
 *   - **No buffering.** Each append opens, writes one line, closes.
 *   - **Rotation.** When an append would push the ledger past
 *     `maxBytes`, the current file is renamed to `<name>.1` (replacing any
 *     prior rollover) and the append starts a fresh ledger.
 *   - **Best-effort at the entry points.** {@link appendLedgerRecord}
 *     itself throws on fs failure; each public appender catches, warns via
 *     `Logger`, and returns `false` so metric capture can never fail the
 *     wrapped plan phase or Story close.
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

/**
 * Record kind for a per-close, per-lens findings-yield entry (Story #4699).
 * One record per Story close whose review ran (or floor-skipped) at least
 * one local lens:
 *
 * ```json
 * { "v": 1, "kind": "findings-yield", "cli": "story-close-review",
 *   "storyId": 4699, "epicId": null,
 *   "lenses": [{ "lens": "audit-clean-code", "findings": 0,
 *                "skippedByFloor": false }],
 *   "diffFloor": { "skip": false, "reason": "at-or-above-floor",
 *                  "floor": 40, "changedLineCount": 120 },
 *   "at": "..." }
 * ```
 *
 * The ledger only records — no roster behavior changes ride on it. Its
 * purpose is evidentiary: a lens that stays at zero findings across N
 * closes becomes droppable on measurement instead of assumption.
 */
const PLAN_METRICS_KIND_FINDINGS_YIELD = 'findings-yield';

/**
 * Rotation threshold. At ~200 bytes per record this is ~5000 invocations —
 * far beyond any real plan run, so rotation only fires on pathological
 * accumulation.
 */
export const MAX_LEDGER_BYTES = 1024 * 1024;

/**
 * Resolve the ledger path for an Epic (or the standalone stream when
 * `epicId` is `null` — the `story-plan.js` / Epic-less healthcheck case).
 *
 * @param {number|null} epicId
 * @param {object} [config] Resolved config (threads `project.paths.tempRoot`).
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
 * Rotate the ledger when appending `incomingBytes` would exceed
 * `maxBytes`. Single-generation rollover: `plan-metrics.json` →
 * `plan-metrics.json.1` (any prior `.1` is replaced).
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
    return false; // No existing ledger — nothing to rotate.
  }
  if (size + incomingBytes <= maxBytes) return false;
  await fs.rename(filePath, `${filePath}.1`);
  return true;
}

/**
 * The single ledger append tail (Story #4712): serialize the record to one
 * newline-terminated JSON line, create the ledger directory lazily, rotate
 * when the byte cap would be exceeded, and append.
 *
 * Throws on any fs failure — the best-effort posture (warn + `false`,
 * never throw) belongs to the public appenders that wrap this, because
 * each labels its own failure mode.
 *
 * @param {object} record Fully-built ledger record (already validated).
 * @param {{
 *   epicId?: number|null,
 *   config?: object,
 *   maxBytes?: number,
 * }} [opts] `maxBytes` is a test seam for the rotation threshold.
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
 * Append one findings-yield record (Story #4699). Called once per Story
 * close by the review spine when the local-lens pass matched (or
 * floor-skipped) at least one lens. Best-effort: returns `false` (after a
 * `Logger.warn`) instead of throwing on any failure, so a ledger failure
 * can never fail the close.
 *
 * @param {{
 *   storyId: number,
 *   lenses: Array<{ lens: string, findings?: number, skippedByFloor?: boolean }>,
 *   cli?: string,
 *   epicId?: number|null,
 *   diffFloor?: object|null,
 * }} entry
 * @param {object} [config]
 * @param {{ maxBytes?: number }} [opts] Test seam for the rotation threshold.
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
