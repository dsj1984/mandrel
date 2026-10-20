/**
 * board-graphql-latch — a Claude Code cloud session's proxy refuses GitHub
 * GraphQL, and Projects v2 has no REST surface, so the board cannot sync at
 * all. Board seams report `reason: 'graphql-blocked'` (a skip, not a
 * failure) and this latch warns once per process. It wraps
 * `board-access-latch.js`, so one classifier names both access failures.
 * Labels stay authoritative: nothing here aborts a run.
 */

import { isGraphqlBlocked } from '../../providers/github/errors.js';
import { Logger } from '../Logger.js';
import {
  boardScopeFailure,
  isProjectAccessFailure,
  reportBoardScopeFailure,
  SCOPE_FAILURE,
} from './board-access-latch.js';

/** The outcome shape a board seam reports for a GraphQL-blocked session. */
const GRAPHQL_BLOCKED_FAILURE = Object.freeze({
  reason: 'graphql-blocked',
});

const REMEDY =
  'GitHub Projects v2 board updates are skipped: this session refuses GitHub GraphQL (Claude Code cloud proxy), and Projects v2 is GraphQL-only, so board adds and Status flips cannot sync from a cloud session (labels still move). Run `node .agents/scripts/board-backfill.js` from a local session to catch the board up.';

// Sinks already warned; production shares one `Logger`, so once per process.
const warnedSinks = new WeakSet();

/**
 * Record a GraphQL-blocked board failure; the first call per process (per
 * sink) emits the one warning, later calls are silent.
 *
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {boolean} true when this call emitted the warning.
 */
function reportBoardGraphqlBlocked({ logger = Logger } = {}) {
  if (warnedSinks.has(logger)) return false;
  warnedSinks.add(logger);
  logger.warn?.(REMEDY);
  return true;
}

/**
 * Is `err` any board access failure: a GraphQL-blocked session, or a
 * token-scope / auth refusal?
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isBoardAccessFailure(err) {
  return isGraphqlBlocked(err) || isProjectAccessFailure(err);
}

/**
 * The access-failure reason `err` names, or null when it is none.
 *
 * @param {unknown} err
 * @returns {'graphql-blocked' | 'insufficient-scope' | null}
 */
export function boardAccessFailureReason(err) {
  if (isGraphqlBlocked(err)) return GRAPHQL_BLOCKED_FAILURE.reason;
  return isProjectAccessFailure(err) ? SCOPE_FAILURE.reason : null;
}

/**
 * Trip the latch for `reason` (one warning per process per reason) and
 * return the outcome a Status sync reports: a GraphQL-blocked session is a
 * skip, a scope refusal a failure.
 *
 * @param {'graphql-blocked' | 'insufficient-scope'} reason
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {{ status: 'skipped', reason: 'graphql-blocked' } | { status: 'failed', reason: 'insufficient-scope', scope: 'project' }}
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
 * Classify a board-add failure: a GraphQL-blocked session or a scope/auth
 * refusal trips its latch and yields the outcome fields to report; anything
 * else yields null.
 *
 * @param {unknown} err
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {{ reason: 'graphql-blocked' } | { reason: 'insufficient-scope', scope: 'project' } | null}
 */
export function boardAccessFailure(err, { logger } = {}) {
  if (!isGraphqlBlocked(err)) return boardScopeFailure(err, { logger });
  reportBoardGraphqlBlocked({ logger });
  return GRAPHQL_BLOCKED_FAILURE;
}
