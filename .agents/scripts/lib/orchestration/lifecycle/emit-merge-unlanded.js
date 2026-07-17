/**
 * emit-merge-unlanded.js — Story #4426 (Epic #4425, slice 1: foundation).
 *
 * Programmatic helper that appends a single `merge.unlanded` NDJSON
 * record to the lifecycle ledger whenever a headless delivery run
 * finishes its work without a confirmed merge. Pattern mirrors
 * `emit-story-heartbeat.js`: direct schema validation via Ajv followed by
 * a synchronous `appendFileSync` — this event is NOT routed through the
 * bus (unlike `emit-loop-tick.js`) because it fires from the standalone
 * `single-story-close` flow, which has no bus at all. A bare append keeps
 * the call site simple and dependency-free.
 *
 * Ledger destination (Story #4426 AC4): `storyLedgerPath(null, ticketId)`
 * — the standalone story-scope destination
 * `temp/standalone/stories/story-<id>/lifecycle.ndjson`, where `ticketId`
 * is the storyId. The `single-story-close` path has no parent Epic to
 * anchor a run directory to, mirroring the `eid === null` standalone
 * convention `signalsFile` already uses for Story-level signals.
 *
 * A caller may always override the destination via `ledgerPath` (tests,
 * or a future caller with a non-default temp layout).
 *
 * Distinct from:
 *   - `epic.merge.blocked` — AutomergePredicate's "not safe to arm yet"
 *     signal, evaluated BEFORE arming. `merge.unlanded` fires AFTER a
 *     delivery flow has already finished trying and gives up.
 *   - `epic.blocked` / `story.blocked` — the generic `agent::blocked`
 *     transition signal. `merge.unlanded` is the merge-specific
 *     diagnosis a `*.blocked` transition is typically paired with, not a
 *     replacement for it.
 *
 * The emit is best-effort in the sense that a failure to append MUST NOT
 * mask the underlying blocked-state transition the caller is already
 * driving — callers should treat this the same way
 * `emitStoryHeartbeat` documents: catch, log, and proceed with the label
 * flip / friction comment regardless.
 *
 * Schema contract (merge.unlanded.schema.json):
 *   { event, scope, ticketId, prNumber, blockClass, reason,
 *     elapsedSeconds, timestamp? }
 *
 * The schema declares `additionalProperties: false`, so this emitter's
 * signature is deliberately narrow: only the schema-allowed fields are
 * accepted. `blockClass` MUST be a valid `merge.unlanded` attribution from
 * `merge-block-class.js` (`MERGE_UNLANDED_BLOCK_CLASSES` — the four
 * `classifyMergeBlock` outputs plus the directly-emitted `predicate-refused`,
 * Story #4472). For a post-arm poll-exhaustion block, pass the classifier's
 * verdict straight through (`classifyMergeBlock(...)` returns
 * `{ blockClass, reason }`); the predicate/armer refusal paths pass
 * `predicate-refused` / a classified arm failure directly.
 */

import { isValidBlockClass } from '../merge-block-class.js';
import {
  appendLedgerEvent,
  assertMergeTerminalFields,
} from './emit-ledger-event.js';

/**
 * Append exactly one `merge.unlanded` NDJSON record to the resolved
 * lifecycle ledger.
 *
 * @param {object} opts
 * @param {'story'} opts.scope         Which delivery path is reporting the
 *                                     unlanded merge.
 * @param {number} opts.ticketId       The storyId.
 * @param {number} opts.prNumber       The PR number that did not land.
 * @param {string} opts.blockClass     A valid `merge.unlanded` attribution
 *                                     (`MERGE_UNLANDED_BLOCK_CLASSES` in
 *                                     `merge-block-class.js`).
 * @param {string} opts.reason         Free-form diagnosis detail — pass
 *                                     the classifier's `reason`.
 * @param {number} opts.elapsedSeconds Elapsed watch/poll time when the
 *                                     run gave up.
 * @param {string} [opts.timestamp]    ISO-8601 wall clock. Defaults to
 *                                     now().
 * @param {object} [opts.config]       Optional resolved config for
 *                                     tempRoot.
 * @param {string} [opts.ledgerPath]   Override for tests / non-default
 *                                     layouts.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitMergeUnlanded(opts) {
  const {
    scope,
    ticketId,
    prNumber,
    blockClass,
    reason,
    elapsedSeconds,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};

  assertMergeTerminalFields('emitMergeUnlanded', {
    scope,
    ticketId,
    prNumber,
    reason,
    elapsedSeconds,
  });
  if (!isValidBlockClass(blockClass)) {
    throw new Error(
      `emitMergeUnlanded: blockClass "${blockClass}" is not a recognised merge-block-class value`,
    );
  }

  return appendLedgerEvent({
    emitter: 'emitMergeUnlanded',
    schemaFile: 'merge.unlanded.schema.json',
    payload: {
      event: 'merge.unlanded',
      scope,
      ticketId,
      prNumber,
      blockClass,
      reason,
      elapsedSeconds,
      timestamp,
    },
    ticketId,
    timestamp,
    config,
    ledgerPath: ledgerPathOverride,
  });
}
