/**
 * Record a confirmed merge whose `agent::done` label write failed. Distinct
 * from `merge.unlanded` because the merge landed — the remedy is re-running
 * the idempotent confirm-merge, not chasing branch protection. The caller
 * still blocks the Story so it is never stranded at `agent::closing`.
 */

import {
  appendLedgerEvent,
  assertMergeTerminalFields,
} from './emit-ledger-event.js';

export const MERGED_FLIP_FAILED_BLOCK_CLASS = 'merged-flip-failed';

/**
 * @param {object} opts
 * @param {'story'} opts.scope
 * @param {number} opts.ticketId
 * @param {number} opts.prNumber
 * @param {string} opts.reason
 * @param {number} opts.elapsedSeconds
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
