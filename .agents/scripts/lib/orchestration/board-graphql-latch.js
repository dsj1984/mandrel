/**
 * board-graphql-latch — a cloud session's proxy refuses GraphQL, and
 * Projects v2 is GraphQL-only, so board seams report `graphql-blocked` and
 * warn once per process. Wraps `board-access-latch.js`.
 */

import { isGraphqlBlocked } from '../../providers/github/errors.js';
import { Logger } from '../Logger.js';
import {
  boardScopeFailure,
  isProjectAccessFailure,
  reportBoardScopeFailure,
  SCOPE_FAILURE,
} from './board-access-latch.js';

const GRAPHQL_BLOCKED_FAILURE = Object.freeze({
  reason: 'graphql-blocked',
});

const REMEDY =
  'GitHub Projects v2 board updates are skipped: this session refuses GitHub GraphQL (Claude Code cloud proxy), and Projects v2 is GraphQL-only, so board adds and Status flips cannot sync from a cloud session (labels still move). Run `node .agents/scripts/board-backfill.js` from a local session to catch the board up.';

const warnedSinks = new WeakSet();

function reportBoardGraphqlBlocked({ logger = Logger } = {}) {
  if (warnedSinks.has(logger)) return false;
  warnedSinks.add(logger);
  logger.warn?.(REMEDY);
  return true;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isBoardAccessFailure(err) {
  return isGraphqlBlocked(err) || isProjectAccessFailure(err);
}

/**
 * @param {unknown} err
 * @returns {'graphql-blocked' | 'insufficient-scope' | null}
 */
export function boardAccessFailureReason(err) {
  if (isGraphqlBlocked(err)) return GRAPHQL_BLOCKED_FAILURE.reason;
  return isProjectAccessFailure(err) ? SCOPE_FAILURE.reason : null;
}

/**
 * The Status-sync outcome for `reason`: a blocked session skips, a scope
 * refusal fails.
 *
 * @param {'graphql-blocked' | 'insufficient-scope'} reason
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {{ status: string, reason: string, scope?: string }}
 */
export function reportBoardAccessFailure(reason, { logger } = {}) {
  if (reason === GRAPHQL_BLOCKED_FAILURE.reason) {
    reportBoardGraphqlBlocked({ logger });
    return { status: 'skipped', ...GRAPHQL_BLOCKED_FAILURE };
  }
  reportBoardScopeFailure({ logger });
  return { status: 'failed', ...SCOPE_FAILURE };
}

/**
 * @param {unknown} err
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {{ reason: string, scope?: string } | null}
 */
export function boardAccessFailure(err, { logger } = {}) {
  if (!isGraphqlBlocked(err)) return boardScopeFailure(err, { logger });
  reportBoardGraphqlBlocked({ logger });
  return GRAPHQL_BLOCKED_FAILURE;
}
