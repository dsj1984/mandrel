// .agents/scripts/lib/orchestration/lifecycle/trace-logger.js
/**
 * TraceLogger — renders the human-readable `lifecycle.md` companion
 * from the canonical NDJSON ledger.
 *
 * The companion is a strict projection of the ledger: re-rendering the
 * same ledger produces byte-identical Markdown (modulo wall-clock `ts`
 * formatting). Editing the companion does NOT affect resume; only the
 * NDJSON ledger is canonical. This is repeatability AC #12.
 *
 * `render(ledger)` is the pure function consumers should call.
 * `TraceLogger.register(bus, writerLedgerPath)` installs the wildcard
 * observer + the on-write side that keeps the companion in sync after
 * every emit, but it does so by re-reading the NDJSON file and calling
 * `render()` — there is no in-memory drift.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Format an ISO-8601 timestamp as HH:MM:SS for the per-event line. The
 * `(durationMs)` chunk is computed from the gap between `emitted` and
 * `completed` (or `failed`) of the same seqId.
 */
function formatClock(iso) {
  // The ledger record schema requires ISO date-time strings (validated
  // up-stream); a defensive `Date` parse here is just for resilience.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '??:??:??';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Phase header derived from event name. The companion is grouped by
 * phase so operators can scan to the section that interests them. The
 * mapping is stable across runs.
 */
const PHASE_BY_PREFIX = Object.freeze({
  'epic.snapshot': 'Snapshot',
  'epic.plan': 'Plan',
  wave: 'Waves',
  'story.dispatch': 'Waves',
  'story.merged': 'Waves',
  'story.blocked': 'Waves',
  'epic.blocked': 'Waves',
  'epic.unblocked': 'Waves',
  'epic.close': 'Close-tail',
  'acceptance.reconcile': 'Acceptance Reconciliation',
  'epic.finalize': 'Finalize',
  'pr.created': 'Finalize',
  'epic.watch': 'Watch',
  'epic.automerge': 'Automerge',
  'epic.merge': 'Automerge',
  'epic.cleanup': 'Cleanup',
  'epic.complete': 'Complete',
  'notification.emitted': 'Notifications',
  'checkpoint.written': 'Checkpoint',
});

function phaseFor(eventName) {
  // Match longest prefix first so `epic.snapshot.start` resolves before
  // `epic.snapshot` would match an unrelated `epic.*` block.
  const keys = Object.keys(PHASE_BY_PREFIX).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (eventName === k || eventName.startsWith(`${k}.`)) {
      return PHASE_BY_PREFIX[k];
    }
  }
  return 'Other';
}

/**
 * Render the payload summary chunk for a per-event line. We keep it
 * short: keys + scalar values, no nested object dumps (the canonical
 * NDJSON ledger is the place to recover full payloads). This matches
 * the Tech Spec spec: "payload-summary".
 */
function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=[${v.length}]`);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v);
      parts.push(`${k}={${keys.length}}`);
    }
  }
  return parts.join(' ');
}

/**
 * Parse an NDJSON ledger string into an array of records. Blank lines
 * and trailing whitespace are tolerated; malformed lines throw with
 * line number so the operator can locate the corruption.
 */
export function parseLedger(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_err) {
      throw new Error(
        `lifecycle ledger: malformed JSON on line ${i + 1}: ${line.slice(0, 80)}`,
      );
    }
  }
  return out;
}

/**
 * Pure render of a parsed ledger to Markdown. Same input → byte-identical
 * output (modulo `ts` field formatting, which is wall-clock by design).
 *
 * Layout (mirroring Tech Spec § Human-readable companion):
 *   # Lifecycle — epic <id>
 *
 *   ## <Phase>
 *   HH:MM:SS  event.name  (durationMs)  payload-summary
 *   ...
 *
 *   ## Summary
 *   - Events: N
 *   - Failed: N
 *   - …
 */
export function render(ledger, opts = {}) {
  const records = Array.isArray(ledger) ? ledger : parseLedger(ledger);
  const emittedBySeq = new Map();
  const terminalBySeq = new Map(); // seqId -> 'completed' | 'failed' record
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'emitted') emittedBySeq.set(rec.seqId, rec);
    else if (rec.kind === 'completed' || rec.kind === 'failed')
      terminalBySeq.set(rec.seqId, rec);
  }

  const phaseOrder = [];
  const phaseLines = new Map();
  for (const emit of [...emittedBySeq.values()].sort(
    (a, b) => a.seqId - b.seqId,
  )) {
    const phase = phaseFor(emit.event);
    if (!phaseLines.has(phase)) {
      phaseLines.set(phase, []);
      phaseOrder.push(phase);
    }
    const terminal = terminalBySeq.get(emit.seqId);
    let durationMs = '';
    if (terminal) {
      const start = new Date(emit.ts).getTime();
      const end = new Date(terminal.ts).getTime();
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= start
      ) {
        durationMs = `(${end - start}ms)`;
      }
    } else {
      durationMs = '(pending)';
    }
    const summary = summarizePayload(emit.payload);
    const failedMarker = terminal && terminal.kind === 'failed' ? ' ⚠️ FAILED' : '';
    const parts = [formatClock(emit.ts), emit.event, durationMs, summary].filter(
      Boolean,
    );
    phaseLines.get(phase).push(parts.join('  ') + failedMarker);
  }

  const lines = [];
  const epicId = opts.epicId ? `epic ${opts.epicId}` : 'epic';
  lines.push(`# Lifecycle — ${epicId}`);
  lines.push('');
  for (const phase of phaseOrder) {
    lines.push(`## ${phase}`);
    lines.push('');
    for (const l of phaseLines.get(phase)) {
      lines.push(l);
    }
    lines.push('');
  }
  // Summary block
  const totalEvents = emittedBySeq.size;
  const failedCount = [...terminalBySeq.values()].filter(
    (r) => r.kind === 'failed',
  ).length;
  const completedCount = totalEvents - failedCount;
  const phaseDurations = [];
  for (const phase of phaseOrder) {
    const seqIds = [...emittedBySeq.values()]
      .filter((e) => phaseFor(e.event) === phase)
      .map((e) => e.seqId);
    if (seqIds.length === 0) continue;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const sid of seqIds) {
      const e = emittedBySeq.get(sid);
      const t = terminalBySeq.get(sid);
      const start = new Date(e.ts).getTime();
      if (Number.isFinite(start) && start < minStart) minStart = start;
      if (t) {
        const end = new Date(t.ts).getTime();
        if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
      }
    }
    if (Number.isFinite(minStart) && Number.isFinite(maxEnd)) {
      phaseDurations.push(`  - ${phase}: ${maxEnd - minStart}ms`);
    }
  }
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Events: ${totalEvents}`);
  lines.push(`- Completed: ${completedCount}`);
  lines.push(`- Failed: ${failedCount}`);
  if (phaseDurations.length > 0) {
    lines.push('- Phase durations:');
    for (const pd of phaseDurations) lines.push(pd);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * TraceLogger wires `render()` against a live bus + ledger file. It is
 * a wildcard observer: it does not mutate state under orchestration, it
 * only re-renders the companion markdown on every event.
 *
 * The wildcard-firewall rule (Tech Spec § Bus contract) requires that
 * trace observers do NOT import any module that mutates GitHub state,
 * the worktree, or the filesystem outside `temp/epic-<id>/`. This
 * module satisfies that constraint: the only filesystem writes are to
 * the companion path under the same temp directory the ledger lives
 * in.
 */
export class TraceLogger {
  /**
   * @param {object} opts
   * @param {string} opts.ledgerPath - absolute path to the NDJSON ledger
   *   the bus is writing (matches `LedgerWriter.ledgerPath`).
   * @param {number} [opts.epicId] - included in the companion header.
   */
  constructor(opts) {
    if (!opts || typeof opts.ledgerPath !== 'string' || opts.ledgerPath.length === 0) {
      throw new TypeError('TraceLogger: opts.ledgerPath is required');
    }
    this._ledgerPath = opts.ledgerPath;
    this._companionPath = path.join(
      path.dirname(this._ledgerPath),
      'lifecycle.md',
    );
    this._epicId = opts.epicId ?? null;
  }

  get companionPath() {
    return this._companionPath;
  }

  /**
   * Re-render the companion from the on-disk ledger. Idempotent.
   */
  rerender() {
    let text;
    try {
      text = readFileSync(this._ledgerPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // ledger not yet written
      throw err;
    }
    const markdown = render(text, { epicId: this._epicId });
    writeFileSync(this._companionPath, markdown, 'utf8');
  }

  /**
   * Register as a wildcard observer. After every emit, re-read the
   * ledger and re-render the companion.
   */
  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError('TraceLogger.register: bus must expose .on()');
    }
    bus.on('*', () => {
      this.rerender();
    });
  }
}

export function createTraceLogger(opts) {
  return new TraceLogger(opts);
}
