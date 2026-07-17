/**
 * emit-merge-flip-failed.js — Story #4539.
 *
 * Appends a single `merge.flip-failed` NDJSON record when a delivery run
 * observed a **confirmed merge** but the `agent::closing → agent::done`
 * label write itself failed.
 *
 * Why this is not `merge.unlanded`: the merge landed. Reporting it as
 * unlanded points the operator at branch protection, required checks, and
 * poll budgets — none of which are the fault — while the real remedy is a
 * re-run of `single-story-confirm-merge.js`, which is idempotent and flips
 * the label from the already-merged PR. The two events are deliberately
 * distinct so the ledger attributes a label-write API failure differently
 * from a merge that never happened.
 *
 * The Story is still transitioned to `agent::blocked` by the caller: a
 * merged PR whose Story sits at `agent::closing` is exactly the silent
 * strand the must-land contract exists to prevent, so it terminates
 * explicitly — but it terminates with the truth.
 */

import {
  appendLedgerEvent,
  assertMergeTerminalFields,
} from './emit-ledger-event.js';

/**
 * The only block class this event carries. Distinct from every
 * `merge.unlanded` attribution (`MERGE_UNLANDED_BLOCK_CLASSES`) because the
 * merge is not in question here — only the label write is.
 */
export const MERGED_FLIP_FAILED_BLOCK_CLASS = 'merged-flip-failed';

/**
 * Append exactly one `merge.flip-failed` record to the resolved ledger.
 *
 * @param {object} opts
 * @param {'story'} opts.scope
 * @param {number} opts.ticketId       The storyId.
 * @param {number} opts.prNumber       The PR that merged.
 * @param {string} opts.reason         What failed on the label write.
 * @param {number} opts.elapsedSeconds Elapsed poll time when the flip failed.
 * @param {string} [opts.timestamp]
 * @param {object} [opts.config]
 * @param {string} [opts.ledgerPath]
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitMergeFlipFailed(opts) {
  const {
    scope,
    ticketId,
    prNumber,
    reason,
    elapsedSeconds,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath,
  } = opts ?? {};

  assertMergeTerminalFields('emitMergeFlipFailed', {
    scope,
    ticketId,
    prNumber,
    reason,
    elapsedSeconds,
  });

  return appendLedgerEvent({
    emitter: 'emitMergeFlipFailed',
    schemaFile: 'merge.flip-failed.schema.json',
    payload: {
      event: 'merge.flip-failed',
      scope,
      ticketId,
      prNumber,
      blockClass: MERGED_FLIP_FAILED_BLOCK_CLASS,
      reason,
      elapsedSeconds,
      timestamp,
    },
    ticketId,
    timestamp,
    config,
    ledgerPath,
  });
}
