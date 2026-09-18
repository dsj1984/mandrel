/**
 * Append one `merge.unlanded` record to the Story's lifecycle ledger when a
 * delivery run gives up without a confirmed merge (after arming, unlike the
 * pre-arm `epic.merge.blocked`). Callers must catch a failed append and still
 * drive the blocked-state transition. The schema forbids extra properties, so
 * the signature is narrow; `blockClass` must be a `merge-block-class.js`
 * value.
 */

import { isValidBlockClass } from '../merge-block-class.js';
import {
  appendLedgerEvent,
  assertMergeTerminalFields,
} from './emit-ledger-event.js';

/**
 * @param {object} opts
 * @param {'story'} opts.scope
 * @param {number} opts.ticketId
 * @param {number} opts.prNumber
 * @param {string} opts.blockClass
 * @param {string} opts.reason
 * @param {number} opts.elapsedSeconds
 * @param {string} [opts.timestamp]
 * @param {object} [opts.config]
 * @param {string} [opts.ledgerPath]
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
