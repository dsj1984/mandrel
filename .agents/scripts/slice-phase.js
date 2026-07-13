#!/usr/bin/env node

/**
 * slice-phase.js — single-delivery slice lifecycle + checkpoint writer
 * (Epic #4475, M4-B). The single-delivery analogue of `story-phase.js`.
 *
 * A single-delivery run collapses the whole Epic into one long guarded session
 * walking the Epic body's `## Delivery Slicing` table on `epic/<id>` (there is
 * no per-Story fan-out, so no `story.heartbeat`). The `deliver-epic-single.md`
 * executor calls this CLI at each slice boundary so the run has:
 *
 *   1. A ledger signal — one `slice.start` / `slice.end` / `slice.heartbeat`
 *      record appended to `temp/epic-<epicId>/lifecycle.ndjson` (via the M4-A
 *      `emit-slice-lifecycle.js` emitters). `slice.heartbeat` is the
 *      forward-progress signal the `/deliver` §2e Idle Watchdog reads to tell
 *      the one long session apart from a dead one; `slice.start`/`.end` bracket
 *      each slice.
 *   2. A durable checkpoint flip — when `--record <status>` is passed (the
 *      executor passes `--record done` after a slice commits to `epic/<id>`),
 *      `slices[sliceId].status` is spliced `pending → done` on the
 *      `epic-run-state` checkpoint so a resumed run SKIPS the already-landed
 *      slice (the branch already carries the work — no re-pay).
 *
 * The ledger emit is best-effort: a missing/unreachable ledger or a schema
 * hiccup is logged and swallowed — the checkpoint is the source of truth, the
 * ledger record is observability (mirrors `story-phase.js`). The checkpoint
 * flip (when requested) is authoritative and its failure propagates.
 *
 * CLI:
 *   --epic <id>                          Epic ID (required).
 *   --slice <sliceId>                    Slice-map key, e.g. slice-1 (required).
 *   --event <start|end|heartbeat>        Lifecycle event to emit (required).
 *   --outcome <done|blocked|failed|skipped>
 *                                        Required for --event end.
 *   --record <pending|done|blocked|failed>
 *                                        Flip slices[sliceId].status on the
 *                                        checkpoint. Omit to leave it untouched.
 *   --slice-index <n>                    Zero-based table position (metadata).
 *   --title <str>                        Human-readable slice label.
 *   --phase <init|implementing|closing|blocked|done>
 *                                        Heartbeat phase (default implementing).
 *   --duration-ms <n>                    Slice duration for --event end.
 *   --no-emit                            Suppress the ledger emit (tests).
 *
 * Stdout: a single JSON envelope
 *   { ok, epicId, sliceId, event, emitted, ledgerPath, recorded, status }
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { recordSliceStatus } from './lib/orchestration/epic-run-state-store.js';
import {
  emitSliceEnd,
  emitSliceHeartbeat,
  emitSliceStart,
} from './lib/orchestration/lifecycle/emit-slice-lifecycle.js';
import { normalizeOperatorHandle } from './lib/orchestration/ticket-lease.js';
import { createProvider } from './lib/provider-factory.js';

const VALID_EVENTS = new Set(['start', 'end', 'heartbeat']);
const VALID_OUTCOMES = new Set(['done', 'blocked', 'failed', 'skipped']);
const VALID_HEARTBEAT_PHASES = new Set([
  'init',
  'implementing',
  'closing',
  'blocked',
  'done',
]);

const HELP = `Usage: node .agents/scripts/slice-phase.js \\
  --epic <id> --slice <sliceId> --event <start|end|heartbeat> \\
  [--outcome <done|blocked|failed|skipped>] [--record <pending|done|blocked|failed>] \\
  [--slice-index <n>] [--title <str>] [--phase <phase>] [--duration-ms <n>] [--no-emit]

Emits one slice.start / slice.end / slice.heartbeat record to the Epic's
lifecycle ledger and, when --record is supplied, flips slices[sliceId].status
on the epic-run-state checkpoint (the M4-B single-delivery slice walk uses
--record done after each slice commits to epic/<id> so resume skips it).
`;

/**
 * Best-effort ledger emit for one slice boundary. Dispatches to the matching
 * `emit-slice-lifecycle.js` emitter and swallows any append failure (logged,
 * never fatal) — the checkpoint is state, the ledger is observability. A
 * programming error (bad event / missing outcome) still throws so it surfaces
 * in tests.
 *
 * @param {object} args
 * @returns {{ emitted: boolean, ledgerPath: string|null }}
 */
function emitSliceEventBestEffort({
  event,
  epicId,
  sliceId,
  sliceIndex,
  title,
  outcome,
  durationMs,
  phase,
  operator,
  config,
  ledgerPath,
  timestamp,
}) {
  try {
    let res;
    if (event === 'start') {
      res = emitSliceStart({
        epicId,
        sliceId,
        ...(Number.isInteger(sliceIndex) ? { sliceIndex } : {}),
        ...(typeof title === 'string' ? { title } : {}),
        timestamp,
        config: config ?? undefined,
        ledgerPath,
      });
    } else if (event === 'end') {
      res = emitSliceEnd({
        epicId,
        sliceId,
        outcome,
        ...(Number.isInteger(sliceIndex) ? { sliceIndex } : {}),
        ...(Number.isInteger(durationMs) ? { durationMs } : {}),
        timestamp,
        config: config ?? undefined,
        ledgerPath,
      });
    } else {
      res = emitSliceHeartbeat({
        epicId,
        sliceId,
        phase,
        timestamp,
        ...(operator !== null && operator !== undefined ? { operator } : {}),
        config: config ?? undefined,
        ledgerPath,
      });
    }
    return { emitted: true, ledgerPath: res.ledgerPath };
  } catch (err) {
    Logger.warn(
      `[slice-phase] slice.${event} emit failed (continuing): ${err.message}`,
    );
    return { emitted: false, ledgerPath: null };
  }
}

/**
 * End-to-end slice-phase writer. DI-friendly: tests pass `provider`, override
 * the ledger path, and skip the emit as needed.
 *
 * @param {{
 *   epicId: number,
 *   sliceId: string,
 *   event: string,
 *   outcome?: string,
 *   record?: string,
 *   sliceIndex?: number,
 *   title?: string,
 *   phase?: string,
 *   durationMs?: number,
 *   noEmit?: boolean,
 *   provider?: object,
 *   config?: object,
 *   ledgerPath?: string,
 *   now?: Date,
 * }} args
 */
export async function runSlicePhase(args) {
  const {
    epicId,
    sliceId,
    event,
    outcome,
    record,
    sliceIndex,
    title,
    phase = 'implementing',
    durationMs,
    noEmit = false,
    provider: providerOverride,
    config: configOverride,
    ledgerPath: ledgerPathOverride,
    now = new Date(),
  } = args ?? {};

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error('runSlicePhase: --epic must be a positive integer');
  }
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new Error('runSlicePhase: --slice must be a non-empty string');
  }
  if (!VALID_EVENTS.has(event)) {
    throw new Error(
      `runSlicePhase: --event "${event}" must be one of: ${[...VALID_EVENTS].join(', ')}`,
    );
  }
  if (event === 'end' && !VALID_OUTCOMES.has(outcome)) {
    throw new Error(
      `runSlicePhase: --event end requires --outcome one of: ${[...VALID_OUTCOMES].join(', ')}`,
    );
  }
  if (event === 'heartbeat' && !VALID_HEARTBEAT_PHASES.has(phase)) {
    throw new Error(
      `runSlicePhase: --phase "${phase}" must be one of: ${[...VALID_HEARTBEAT_PHASES].join(', ')}`,
    );
  }

  const config = configOverride ?? (providerOverride ? null : resolveConfig());
  const operator = normalizeOperatorHandle(config?.github?.operatorHandle);
  const timestamp = now.toISOString();

  let emitted = false;
  let ledgerPath = null;
  if (!noEmit) {
    ({ emitted, ledgerPath } = emitSliceEventBestEffort({
      event,
      epicId,
      sliceId,
      sliceIndex,
      title,
      outcome,
      durationMs,
      phase,
      operator,
      config,
      ledgerPath: ledgerPathOverride,
      timestamp,
    }));
  }

  // Authoritative checkpoint flip — only when --record is supplied. Unlike the
  // best-effort emit, a record failure propagates (the slice-map marker is the
  // resume contract; a silent failure would re-pay the slice on resume).
  let recorded = false;
  let status = null;
  if (typeof record === 'string' && record.length > 0) {
    const provider =
      providerOverride ?? createProvider(config ?? resolveConfig());
    await recordSliceStatus({
      provider,
      epicId,
      sliceId,
      status: record,
      ...(typeof title === 'string' && title ? { title } : {}),
    });
    recorded = true;
    status = record;
  }

  return {
    ok: true,
    epicId,
    sliceId,
    event,
    emitted,
    ledgerPath,
    recorded,
    status,
  };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      slice: { type: 'string' },
      event: { type: 'string' },
      outcome: { type: 'string' },
      record: { type: 'string' },
      'slice-index': { type: 'string' },
      title: { type: 'string' },
      phase: { type: 'string' },
      'duration-ms': { type: 'string' },
      'no-emit': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  const parsed = {
    help: Boolean(values.help),
    epicId: Number.parseInt(values.epic ?? '', 10),
    sliceId: values.slice,
    event: values.event,
    noEmit: Boolean(values['no-emit']),
  };
  if (typeof values.outcome === 'string') parsed.outcome = values.outcome;
  if (typeof values.record === 'string') parsed.record = values.record;
  if (typeof values.title === 'string') parsed.title = values.title;
  if (typeof values.phase === 'string') parsed.phase = values.phase;
  if (values['slice-index'] !== undefined) {
    parsed.sliceIndex = Number.parseInt(values['slice-index'], 10);
  }
  if (values['duration-ms'] !== undefined) {
    parsed.durationMs = Number.parseInt(values['duration-ms'], 10);
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const envelope = await runSlicePhase(parsed);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'slice-phase' });
