/**
 * runtime-friction.js — derive friction signals from observables the
 * runtime already has (Story #4578).
 *
 * ## Why this exists
 *
 * Friction telemetry was **opt-in**: a `friction` record existed only when
 * an agent volunteered a `diagnose-friction.js --story <id> --cmd <...>`
 * call. `plan-run-epilogue.js`'s `follow-up-rollup` then read an empty
 * `signals.ndjson` and truthfully reported "No friction signals — nothing
 * to follow up". A 7-Story run containing a mid-run git outage, a parked
 * worker needing an operator resume, and a four-round acceptance critic
 * produced a **zero-signal retro** — because the stream is least likely to
 * fill exactly when a run is going badly and the agent is busy.
 *
 * This module closes that gap from the other side: the runtime emits
 * friction from what it *already knows*, at the point it already knows it.
 * No agent cooperation required.
 *
 * ## Not a second channel
 *
 * These records go through the **existing** `appendSignal` path, carry the
 * **existing** `kind: 'friction'` shape, and land in the **same**
 * `signals.ndjson` stream `diagnose-friction.js` writes and the roll-up
 * reads. The only thing that is new is *who* decides to write.
 *
 * Deliberately distinct from {@link ../gates/friction.js}'s
 * `emitFrictionSignal`, which early-returns unless **both** `storyId` and
 * `epicId` are truthy. Every v2 Story is standalone (`epicId: null` — see
 * `temp-paths.storyTempDir`'s standalone branch), and the roll-up reads the
 * standalone stream via `forEachLine(null, sid, ...)`. Routing runtime
 * friction through the gate helper would drop **every** record on the floor,
 * silently, which is the bug this Story exists to fix.
 *
 * ## Robustness contract
 *
 * Observability MUST NOT halt the runner (`signals-writer.js`; the
 * `docs/patterns.md` friction pattern). Every export here is best-effort:
 * it swallows its own failures after a `Logger.warn` and resolves `false`.
 * A missing signal is strictly preferable to a broken close.
 *
 * @module lib/observability/runtime-friction
 */

import crypto from 'node:crypto';

import { Logger } from '../Logger.js';
import { appendSignal } from './signals-writer.js';

/**
 * The friction categories this module emits.
 *
 * Values are plain strings by design: `signal-event.schema.json` types
 * `category` as a free-form `{ type: 'string', minLength: 1 }`, so no schema
 * change is required to add one. They are frozen here so the emitters and
 * their tests name the same literal instead of spreading it.
 *
 * Category choice is load-bearing for the retro: `retro-proposals.js`
 * aggregates **by exact category string**, so these are deliberately coarse
 * — one bucket per failure mode — rather than per-incident. Two Stories that
 * hit the same wall in one run aggregate to `occurrences: 2` and route as a
 * real proposal instead of being discarded as two unrelated singletons.
 */
export const RUNTIME_FRICTION_CATEGORIES = Object.freeze({
  /** A Story was parked at `agent::blocked` — the HITL pause (§ 1.J). */
  STORY_BLOCKED: 'story-blocked',
  /** A close run ended on a `failed` terminal (non-zero exit). */
  CLOSE_FAILED: 'close-failed',
  /** A bounded merge wait expired with the PR still in flight. */
  MERGE_WAIT_EXHAUSTED: 'merge-wait-exhausted',
});

/** Cap on free-form reason text copied into a signal's `details`. */
const REASON_PREVIEW_LIMIT = 500;

/**
 * @param {unknown} value
 * @returns {string}
 */
function preview(value) {
  return String(value ?? '').slice(0, REASON_PREVIEW_LIMIT);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Append one runtime-derived `friction` record to the Story's signals
 * stream. Best-effort: never throws, never rejects.
 *
 * `epicId` defaults to `null` (the standalone-Story stream) because that is
 * where v2 Stories live and where the roll-up reads.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {number|null} [args.epicId]
 * @param {string} args.category  One of {@link RUNTIME_FRICTION_CATEGORIES}.
 * @param {string} args.tool      Emitting surface, for `emitter.tool`.
 * @param {object} [args.details] Kind-specific payload (always an object).
 * @param {object} [args.config]  Resolved config (for `tempRoot`).
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitRuntimeFriction({
  storyId,
  epicId = null,
  category,
  tool,
  details = {},
  config,
} = {}) {
  const sid = positiveIntOrNull(storyId);
  if (sid === null) {
    // No Story context → no stream to write to. Not an error: some close
    // paths (a usage error before the id is parsed) genuinely have none.
    return false;
  }
  if (typeof category !== 'string' || category.trim() === '') {
    Logger.warn('[runtime-friction] refusing to emit a category-less signal');
    return false;
  }

  const signal = {
    kind: 'friction',
    eventId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    epicId: positiveIntOrNull(epicId),
    storyId: sid,
    // 2-tier hierarchy (Epic #3163): no Task tier. Retained for schema
    // compatibility and always null — mirrors diagnose-friction.js.
    taskId: null,
    category: category.trim(),
    emitter: { tool: tool || 'runtime-friction' },
    details: details && typeof details === 'object' ? details : {},
  };

  try {
    return await appendSignal({
      epicId: signal.epicId,
      storyId: sid,
      signal,
      config,
    });
  } catch (err) {
    // `appendSignal` already swallows its own I/O failures; this catch is
    // defense in depth so a surprise (a poisoned config, a throwing
    // validator) still cannot take down the path being observed.
    Logger.warn(
      `[runtime-friction] append failed for Story #${sid} (${category}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Emit the recovery counterpart of a `story-blocked` record when a Story
 * leaves `agent::blocked` for an active state (Story #4622).
 *
 * A transient block that self-resolves — lease contention or a stale label
 * read under concurrent shared-checkout pressure (swarm-os friction #581) —
 * still fired a `story-blocked` record at the block flip, which the retro
 * composer counts toward the `story-blocked` recurrence total exactly like a
 * terminal block. This emits a companion `story-blocked` record carrying the
 * `details.recovered: true` discriminator, so the composer can net the whole
 * incident out (see `retro-proposals.js`). The category is deliberately kept
 * as `story-blocked` rather than a new bucket: a distinct category would
 * itself aggregate into a routable proposal, re-introducing the noise.
 *
 * Best-effort; never throws.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} [args.fromState] The state parked at (`agent::blocked`).
 * @param {string} [args.toState]   The active state recovered into.
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitBlockRecoveredFriction({
  storyId,
  fromState,
  toState,
  config,
} = {}) {
  return emitRuntimeFriction({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
    tool: 'transitionTicketState',
    details: {
      recovered: true,
      fromState: fromState ?? null,
      toState: toState ?? null,
    },
    config,
  });
}

/**
 * Pure predicate: is this signal a recovery-marked `story-blocked` record?
 * Shared with the retro composer so the "recovered" discriminator is read
 * from one place. A record is a recovery marker when its category is
 * `story-blocked` and `details.recovered === true`.
 *
 * @param {object} signal
 * @returns {boolean}
 */
export function isRecoveredBlockSignal(signal) {
  return (
    signal !== null &&
    typeof signal === 'object' &&
    signal.category === RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED &&
    signal.details !== null &&
    typeof signal.details === 'object' &&
    signal.details.recovered === true
  );
}

/**
 * Decide whether a `story-deliver-terminal` envelope is worth a friction
 * record, and describe it. **Pure** — no I/O — so the (interesting) policy
 * is unit-testable without touching disk.
 *
 * The partition is deliberate; each observable is emitted from exactly ONE
 * place, so one incident never double-counts into `occurrences: 2` and
 * fabricates a filed proposal out of a single event:
 *
 *   - `blocked`  → **null here.** Every blocked terminal flips the Story to
 *     `agent::blocked` (`confirm-merge.js`, both the `merge.unlanded` and
 *     `merge.flip-failed` paths), and that transition is instrumented at the
 *     canonical mutator (`ticketing/transition.js`). Emitting here as well
 *     would count the same block twice.
 *   - `landed`   → null. Nothing happened worth a retro.
 *   - `failed`   → friction. A close that ended non-zero.
 *   - `pending`  → friction **only when a `waitBudget` was exhausted**. That
 *     is the parked worker from the report: a bounded wait expired with the
 *     PR in flight and a human must resume it. A `pending` with **no**
 *     `waitBudget` is the `--no-wait-merge` / operator-merge path, where the
 *     human deliberately owns the land and nothing is broken — flagging it
 *     would train operators to ignore the channel.
 *
 * Deliberately **not exported**: it is this module's internal policy, and
 * `emitTerminalFriction` is the contract callers (and tests) exercise. An
 * export solely for testability would be production-dead code — the
 * `--production` dead-exports ratchet exists to catch exactly that.
 *
 * @param {object} envelope A `story-deliver-terminal` envelope.
 * @returns {{ category: string, details: object }|null}
 */
function frictionForTerminal(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const { status, phase, waitBudget, failure, pr } = envelope;

  if (status === 'failed') {
    return {
      category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
      details: {
        phase: phase ?? null,
        reason: preview(failure?.reason),
      },
    };
  }

  if (status === 'pending' && waitBudget) {
    return {
      category: RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED,
      details: {
        phase: phase ?? null,
        prNumber: pr?.number ?? null,
        checksStatus: pr?.checksStatus ?? null,
        waitedSeconds: waitBudget.waitedSeconds ?? null,
        cumulativeSeconds: waitBudget.cumulativeSeconds ?? null,
        maxBudgetSeconds: waitBudget.maxBudgetSeconds ?? null,
      },
    };
  }

  return null;
}

/**
 * Emit the friction record (if any) implied by a terminal envelope.
 * Best-effort; never throws.
 *
 * @param {object} args
 * @param {object} args.envelope
 * @param {object} [args.config]
 * @returns {Promise<boolean>} true when a record was appended.
 */
export async function emitTerminalFriction({ envelope, config } = {}) {
  const verdict = frictionForTerminal(envelope);
  if (!verdict) return false;
  return emitRuntimeFriction({
    storyId: envelope?.storyId,
    category: verdict.category,
    tool: 'single-story-close',
    details: verdict.details,
    config,
  });
}
