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
  'story.dispatch': 'Waves',
  'story.merged': 'Waves',
  'story.blocked': 'Waves',
  'epic.blocked': 'Waves',
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
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
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
/**
 * Index the ledger records into the two maps `render` needs: the `emitted`
 * record per seqId and the terminal (`completed`/`failed`) record per seqId.
 * Story #4075 — extracted from `render` so the orchestrating body stays flat.
 */
function indexLedgerRecords(records) {
  const emittedBySeq = new Map();
  const terminalBySeq = new Map();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'emitted') emittedBySeq.set(rec.seqId, rec);
    else if (rec.kind === 'completed' || rec.kind === 'failed')
      terminalBySeq.set(rec.seqId, rec);
  }
  return { emittedBySeq, terminalBySeq };
}

/**
 * Compute the `(durationMs)` / `(pending)` chunk for one emitted event,
 * given its terminal record (or undefined when still in flight).
 */
export function formatDurationChunk(emit, terminal) {
  if (!terminal) return '(pending)';
  const start = new Date(emit.ts).getTime();
  const end = new Date(terminal.ts).getTime();
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return `(${end - start}ms)`;
  }
  return '';
}

/**
 * Render a single per-event line for the phase section.
 */
function formatEventLine(emit, terminal) {
  const failedMarker =
    terminal && terminal.kind === 'failed' ? ' ⚠️ FAILED' : '';
  const parts = [
    formatClock(emit.ts),
    emit.event,
    formatDurationChunk(emit, terminal),
    summarizePayload(emit.payload),
  ].filter(Boolean);
  return parts.join('  ') + failedMarker;
}

/**
 * Group emitted events into ordered phase buckets, each carrying its
 * rendered per-event lines. Phase order is first-seen by ascending seqId.
 */
function buildPhaseLines(emittedBySeq, terminalBySeq) {
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
    phaseLines
      .get(phase)
      .push(formatEventLine(emit, terminalBySeq.get(emit.seqId)));
  }
  return { phaseOrder, phaseLines };
}

/**
 * Compute the wall-clock span (`maxEnd - minStart`) of a single phase, or
 * `null` when no finite span can be derived.
 */
function computePhaseSpanMs(phase, emittedBySeq, terminalBySeq) {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const emit of emittedBySeq.values()) {
    if (phaseFor(emit.event) !== phase) continue;
    const start = new Date(emit.ts).getTime();
    if (Number.isFinite(start) && start < minStart) minStart = start;
    const terminal = terminalBySeq.get(emit.seqId);
    if (terminal) {
      const end = new Date(terminal.ts).getTime();
      if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
    }
  }
  return Number.isFinite(minStart) && Number.isFinite(maxEnd)
    ? maxEnd - minStart
    : null;
}

/**
 * Build the trailing `## Summary` block lines.
 */
function buildSummaryLines(phaseOrder, emittedBySeq, terminalBySeq) {
  const totalEvents = emittedBySeq.size;
  const failedCount = [...terminalBySeq.values()].filter(
    (r) => r.kind === 'failed',
  ).length;
  const phaseDurations = [];
  for (const phase of phaseOrder) {
    const spanMs = computePhaseSpanMs(phase, emittedBySeq, terminalBySeq);
    if (spanMs !== null) phaseDurations.push(`  - ${phase}: ${spanMs}ms`);
  }
  const lines = [
    '## Summary',
    '',
    `- Events: ${totalEvents}`,
    `- Completed: ${totalEvents - failedCount}`,
    `- Failed: ${failedCount}`,
  ];
  if (phaseDurations.length > 0) {
    lines.push('- Phase durations:', ...phaseDurations);
  }
  lines.push('');
  return lines;
}

export function render(ledger, opts = {}) {
  const records = Array.isArray(ledger) ? ledger : parseLedger(ledger);
  const { emittedBySeq, terminalBySeq } = indexLedgerRecords(records);
  const { phaseOrder, phaseLines } = buildPhaseLines(
    emittedBySeq,
    terminalBySeq,
  );

  const epicId = opts.epicId ? `epic ${opts.epicId}` : 'epic';
  const lines = [`# Lifecycle — ${epicId}`, ''];
  for (const phase of phaseOrder) {
    lines.push(`## ${phase}`, '', ...phaseLines.get(phase), '');
  }
  lines.push(...buildSummaryLines(phaseOrder, emittedBySeq, terminalBySeq));
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
    if (
      !opts ||
      typeof opts.ledgerPath !== 'string' ||
      opts.ledgerPath.length === 0
    ) {
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
   *
   * The companion render is a best-effort projection: a failed render
   * (malformed ledger, transient write error, full disk) MUST NOT abort
   * the in-flight bus emit. Because wildcard listeners run inside the
   * `emit()` try/catch (see `bus.js`), an unguarded throw here would
   * short-circuit the emit and propagate to the orchestration caller.
   * We instead log the failure to stderr and swallow it, degrading to a
   * stale `lifecycle.md` companion — the canonical NDJSON ledger is
   * unaffected, so resume and downstream consumers are not broken.
   */
  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError('TraceLogger.register: bus must expose .on()');
    }
    bus.on('*', () => {
      try {
        this.rerender();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        process.stderr.write(
          `[TraceLogger] companion rerender failed (degrading to stale lifecycle.md): ${message}\n`,
        );
      }
    });
  }
}
