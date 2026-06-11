// .agents/scripts/lib/orchestration/recurring-failure-detector.js
/**
 * recurring-failure-detector.js — Story #3062 / Epic #3051.
 *
 * Pure helper that scans a per-Epic lifecycle ledger for
 * `close-validate.end` `emitted` records and groups them by `failedGate`.
 * Returns one finding per gate that appears in **two or more distinct
 * Stories** within the same Epic. Findings are the substrate
 * `/deliver` consumes when upserting the cross-Story
 * `recurring-failure-class` structured comment on the Epic ticket.
 *
 * The helper is intentionally pure: no GitHub I/O, no global state. It
 * accepts either a pre-parsed `records[]` array (the hot path used by
 * `wave-tick` once it has already read the ledger for its in-flight
 * reconciliation) or a `ledgerPath` string (the convenience path that
 * reads + parses NDJSON on its own). When both are supplied,
 * `records` wins — the caller already paid the parse cost.
 *
 * Finding shape (sorted lexicographically by `gate` for determinism):
 *
 *   { gate: string, storyIds: number[], firstSeenAt: string, lastSeenAt: string }
 *
 * - `storyIds` is the deduplicated, ascending list of Story IDs that
 *   recorded a `close-validate.end` with `ok: false` and this gate.
 * - `firstSeenAt` / `lastSeenAt` are ISO-8601 strings pulled from the
 *   ledger record's top-level `ts` (set by `LedgerWriter.buildEmitted`),
 *   which is the canonical wall-clock for the event.
 *
 * @module lib/orchestration/recurring-failure-detector
 */

import { existsSync, readFileSync } from 'node:fs';

/**
 * Detect recurring failure classes across Stories within one Epic.
 *
 * @param {number} epicId Positive integer — the Epic the ledger belongs
 *   to. Used only for validation (the helper does not filter records by
 *   epicId; the ledger is already epic-scoped on disk).
 * @param {object} [opts]
 * @param {Array<object>} [opts.records] Pre-parsed NDJSON records. Each
 *   entry is the object emitted by `LedgerWriter.buildEmitted`
 *   (`{ kind, seqId, ts, event, payload }`).
 * @param {string} [opts.ledgerPath] Filesystem path to `lifecycle.ndjson`.
 *   Read + parsed only when `records` is absent. A missing file returns
 *   an empty findings array (no throw).
 * @returns {Array<{gate: string, storyIds: number[], firstSeenAt: string, lastSeenAt: string}>}
 */
export function detectRecurringFailures(epicId, opts = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'detectRecurringFailures: epicId must be a positive integer',
    );
  }
  const records = resolveRecords(opts);
  if (records.length === 0) return [];

  /** @type {Map<string, {storyIds: Set<number>, firstSeenAt: string, lastSeenAt: string}>} */
  const byGate = new Map();
  for (const record of records) {
    const finding = extractFailedGateRecord(record);
    if (!finding) continue;
    const { gate, storyId, ts } = finding;
    const bucket = byGate.get(gate);
    if (!bucket) {
      byGate.set(gate, {
        storyIds: new Set([storyId]),
        firstSeenAt: ts,
        lastSeenAt: ts,
      });
      continue;
    }
    bucket.storyIds.add(storyId);
    if (ts < bucket.firstSeenAt) bucket.firstSeenAt = ts;
    if (ts > bucket.lastSeenAt) bucket.lastSeenAt = ts;
  }

  const findings = [];
  for (const [gate, bucket] of byGate) {
    if (bucket.storyIds.size < 2) continue;
    findings.push({
      gate,
      storyIds: Array.from(bucket.storyIds).sort((a, b) => a - b),
      firstSeenAt: bucket.firstSeenAt,
      lastSeenAt: bucket.lastSeenAt,
    });
  }
  findings.sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : 0));
  return findings;
}

/**
 * Resolve the records array from caller opts. Pre-parsed `records` wins
 * over a `ledgerPath` so callers that already loaded the file (e.g.
 * `wave-tick.js` doing its in-flight reconciliation) don't pay the parse
 * cost twice. A missing ledger file is treated as "no records" — the
 * tick must remain stateless and must not throw when nothing has
 * happened yet on this Epic.
 *
 * @param {object} opts
 * @returns {Array<object>}
 */
function resolveRecords(opts) {
  if (Array.isArray(opts.records)) return opts.records;
  if (typeof opts.ledgerPath !== 'string' || opts.ledgerPath.length === 0) {
    return [];
  }
  if (!existsSync(opts.ledgerPath)) return [];
  let raw;
  try {
    raw = readFileSync(opts.ledgerPath, 'utf8');
  } catch {
    return [];
  }
  if (!raw) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Malformed line — skip; the ledger is append-only NDJSON and a
      // partial write at process death is the only realistic source of
      // un-parseable lines. The next tick will see the completed line.
    }
  }
  return out;
}

/**
 * Decide whether a ledger record is a `close-validate.end` `emitted`
 * payload carrying a failed gate, and if so extract the
 * `(gate, storyId, ts)` triple the bucketing loop consumes. Returns
 * `null` for any record that doesn't satisfy every guard.
 *
 * @param {object} record
 * @returns {{gate: string, storyId: number, ts: string} | null}
 */
function extractFailedGateRecord(record) {
  if (!record || record.kind !== 'emitted') return null;
  if (record.event !== 'close-validate.end') return null;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.ok !== false) return null;
  const gate = payload.failedGate;
  if (typeof gate !== 'string' || gate.length === 0) return null;
  const storyId = payload.storyId;
  if (!Number.isInteger(storyId) || storyId <= 0) return null;
  const ts = typeof record.ts === 'string' && record.ts ? record.ts : '';
  if (!ts) return null;
  return { gate, storyId, ts };
}
