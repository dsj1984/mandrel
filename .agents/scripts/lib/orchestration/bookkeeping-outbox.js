/**
 * bookkeeping-outbox.js — Epic #4476 (M5): buffered GitHub bookkeeping.
 *
 * Delivery bookkeeping — structured-comment upserts (progress, friction,
 * wave-stall, …) and `agent::*` label flips — is human-visible surface that,
 * in an **unattended** (`--yes` / headless) run, no operator is watching in
 * real time. Emitting each one as a live GitHub round-trip mid-run costs an
 * LLM turn per transition for a surface nobody reads until the run finishes.
 *
 * This module lets those non-urgent mutations be **buffered to a local NDJSON
 * outbox** during the run and **reconciled to GitHub once at finalize**.
 * GitHub stays the source of truth *at rest* (post-reconcile); only the
 * per-transition chatter moves off the token stream. The outbox file survives
 * a crash, so crash recovery drains whatever was buffered before the finalize
 * reconcile ran.
 *
 * ## What is NEVER buffered
 * The `agent::blocked` HITL gate (`.agents/instructions.md` §1.J) is the single
 * authoritative runtime pause point. A genuine blocker MUST surface on GitHub
 * **immediately**, not batched to finalize — an operator can only resume a run
 * they can see is blocked. The {@link transitionStateOrBuffer} facade forces
 * `agent::blocked` (and any caller-marked `urgent`) transition through the
 * live path regardless of headless mode.
 *
 * ## Attended runs are unchanged
 * Buffering is gated on the explicit `headless` signal (Story #4427's
 * `--headless`/`--yes` plumbing). An attended run passes `headless: false` and
 * every comment/label posts live exactly as before — byte-for-byte behaviour.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { epicTempDir } from '../config/temp-paths.js';
import { STATE_LABELS } from './ticketing/reads.js';
import { upsertStructuredComment } from './ticketing/state.js';
import { transitionTicketState } from './ticketing/transition.js';

/** Canonical basename for the per-Epic bookkeeping outbox. */
export const OUTBOX_BASENAME = 'bookkeeping-outbox.ndjson';

/**
 * Resolve the canonical outbox path for an Epic:
 * `temp/epic-<id>/bookkeeping-outbox.ndjson`.
 *
 * @param {number} epicId
 * @param {object} [config] Resolved config (tempRoot).
 * @returns {string}
 */
export function outboxPathFor(epicId, config) {
  return path.join(epicTempDir(epicId, config), OUTBOX_BASENAME);
}

/**
 * Append one operation record to the outbox, creating the parent dir on
 * demand. Best-effort at the storage layer is the caller's concern; here we
 * let a genuine fs failure propagate so a mis-configured outbox path surfaces
 * loudly in tests.
 *
 * @param {string} outboxPath
 * @param {object} op
 */
function appendOp(outboxPath, op) {
  mkdirSync(path.dirname(outboxPath), { recursive: true });
  appendFileSync(outboxPath, `${JSON.stringify(op)}\n`, 'utf8');
}

/**
 * Buffer a structured-comment upsert. The op captures everything
 * `upsertStructuredComment` needs at drain time so the reconcile is a pure
 * replay with no re-derivation.
 *
 * @param {{ outboxPath: string, ticketId: number, marker: string,
 *           body: string, attrs?: Record<string, string|number>|null,
 *           ts?: string }} args
 */
export function enqueueComment({
  outboxPath,
  ticketId,
  marker,
  body,
  attrs = null,
  ts = new Date().toISOString(),
}) {
  appendOp(outboxPath, {
    kind: 'comment',
    ts,
    ticketId,
    marker,
    body,
    ...(attrs ? { attrs } : {}),
  });
}

/**
 * Buffer an `agent::*` label transition.
 *
 * @param {{ outboxPath: string, ticketId: number, state: string,
 *           ts?: string }} args
 */
export function enqueueLabel({
  outboxPath,
  ticketId,
  state,
  ts = new Date().toISOString(),
}) {
  appendOp(outboxPath, { kind: 'label', ts, ticketId, state });
}

/**
 * Parse the outbox into an ordered array of operation records. Malformed
 * lines are skipped (never throw). A missing / empty outbox yields `[]`.
 *
 * @param {string} outboxPath
 * @returns {Array<object>}
 */
export function readOutbox(outboxPath) {
  if (!outboxPath || !existsSync(outboxPath)) return [];
  let raw;
  try {
    raw = readFileSync(outboxPath, 'utf8');
  } catch {
    return [];
  }
  if (!raw) return [];
  const ops = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const op = JSON.parse(line);
      if (op && typeof op === 'object') ops.push(op);
    } catch {
      // skip a torn / malformed line — a partial write from a crash is not
      // fatal to the rest of the batch.
    }
  }
  return ops;
}

/**
 * Drain the outbox to GitHub in FIFO order and clear it on success. Both sink
 * operations are idempotent (comment upserts are marker-scoped;
 * `transitionTicketState` applies one state via the canonical
 * remove-all-then-add path), so a re-run after a partial drain converges. A
 * per-op failure is recorded and the drain continues — a single bad ticket
 * must not strand the rest of the batch. The outbox file is only truncated
 * when EVERY op succeeded, so a crash mid-drain leaves the un-applied
 * remainder for the next reconcile.
 *
 * @param {{ outboxPath: string,
 *           provider: import('../ITicketingProvider.js').ITicketingProvider,
 *           logger?: { warn?: (m: string) => void } }} args
 * @returns {Promise<{ drained: number, comments: number, labels: number,
 *   errors: Array<{ op: object, error: string }>, cleared: boolean }>}
 */
export async function reconcileOutbox({ outboxPath, provider, logger }) {
  const ops = readOutbox(outboxPath);
  const result = {
    drained: 0,
    comments: 0,
    labels: 0,
    errors: [],
    cleared: false,
  };
  if (ops.length === 0) {
    result.cleared = true;
    return result;
  }

  for (const op of ops) {
    try {
      if (op.kind === 'comment') {
        await upsertStructuredComment(
          provider,
          op.ticketId,
          op.marker,
          op.body,
          op.attrs ?? null,
        );
        result.comments += 1;
        result.drained += 1;
      } else if (op.kind === 'label') {
        await transitionTicketState(provider, op.ticketId, op.state);
        result.labels += 1;
        result.drained += 1;
      } else {
        result.errors.push({ op, error: `unknown op kind "${op.kind}"` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ op, error: message });
      logger?.warn?.(
        `[bookkeeping-outbox] reconcile op failed (${op.kind} #${op.ticketId}): ${message}`,
      );
    }
  }

  // Only truncate when the whole batch landed — otherwise the un-applied
  // ops must survive for the next reconcile (crash-recovery contract).
  if (result.errors.length === 0) {
    try {
      writeFileSync(outboxPath, '', 'utf8');
      result.cleared = true;
    } catch {
      // A clear failure is non-fatal: the ops all landed, and the idempotent
      // sinks make a redundant re-drain a no-op.
    }
  }
  return result;
}

/**
 * Facade: post a structured comment live, OR buffer it to the outbox when the
 * run is headless. Comments are never urgent (the operator reads them at
 * finalize), so headless always buffers when an `outboxPath` is available.
 *
 * @param {{ provider: object, ticketId: number, marker: string, body: string,
 *           attrs?: Record<string, string|number>|null, headless?: boolean,
 *           outboxPath?: string|null }} args
 * @returns {Promise<{ buffered: boolean }>}
 */
export async function postCommentOrBuffer({
  provider,
  ticketId,
  marker,
  body,
  attrs = null,
  headless = false,
  outboxPath = null,
}) {
  if (headless && outboxPath) {
    enqueueComment({ outboxPath, ticketId, marker, body, attrs });
    return { buffered: true };
  }
  await upsertStructuredComment(provider, ticketId, marker, body, attrs);
  return { buffered: false };
}

/**
 * Facade: flip an `agent::*` state live, OR buffer it when headless — EXCEPT
 * `agent::blocked` (and any caller-marked `urgent` flip), which ALWAYS goes
 * live so the HITL gate surfaces immediately (§1.J).
 *
 * @param {{ provider: object, ticketId: number, state: string,
 *           headless?: boolean, outboxPath?: string|null,
 *           urgent?: boolean }} args
 * @returns {Promise<{ buffered: boolean }>}
 */
export async function transitionStateOrBuffer({
  provider,
  ticketId,
  state,
  headless = false,
  outboxPath = null,
  urgent = false,
}) {
  const mustSurfaceNow = urgent || state === STATE_LABELS.BLOCKED;
  if (headless && outboxPath && !mustSurfaceNow) {
    enqueueLabel({ outboxPath, ticketId, state });
    return { buffered: true };
  }
  await transitionTicketState(provider, ticketId, state);
  return { buffered: false };
}
