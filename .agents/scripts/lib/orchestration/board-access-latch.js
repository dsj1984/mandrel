/**
 * board-access-latch — the typed Projects v2 access failure and a
 * warn-once-per-process latch for it. Labels stay authoritative: nothing
 * here aborts a run.
 */

import {
  errorTextMatches,
  isInsufficientScopes,
} from '../../providers/github/projects-v2-graphql.js';
import { describeGhFailure, GhScopeError } from '../gh-exec.js';
import { Logger } from '../Logger.js';

const PROJECT_SCOPE = 'project';
const PROJECT_SCOPE_REMEDY = 'gh auth refresh -h github.com -s project';

/** The outcome shape a board seam reports for a scope failure. */
export const SCOPE_FAILURE = Object.freeze({
  reason: 'insufficient-scope',
  scope: PROJECT_SCOPE,
});

// GraphQL `FORBIDDEN`, or an explicit HTTP 401/403 from the GraphQL endpoint.
const AUTH_FAILURE_RE =
  /\bFORBIDDEN\b|Bad credentials|\b(?:HTTP|GraphQL) 40[13]\b/;

// Errors typed as a board access refusal, by name so a duplicate module copy
// (or a subclass) still classifies.
const ACCESS_ERROR_NAMES = new Set(['ProjectAccessError', 'GhScopeError']);

/**
 * The board is unreachable with this token — a missing `project` scope or an
 * auth refusal, never an owner-type miss.
 */
export class ProjectAccessError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ProjectAccessError';
    this.scope = PROJECT_SCOPE;
    this.remedy = PROJECT_SCOPE_REMEDY;
  }
}

/**
 * Is `err` a token-scope / auth refusal (as opposed to a NOT_FOUND miss or a
 * transient failure)? A `ProjectAccessError` or a gh-exec `GhScopeError`
 * always is; anything else is judged on the scope / auth text in its
 * `message`, `stderr` or `stdout`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isProjectAccessFailure(err) {
  if (!err) return false;
  if (err instanceof GhScopeError || ACCESS_ERROR_NAMES.has(err.name)) {
    return true;
  }
  return isInsufficientScopes(err) || errorTextMatches(err, AUTH_FAILURE_RE);
}

/**
 * Wrap a raw scope/auth error in a `ProjectAccessError` (idempotent).
 *
 * @param {unknown} err
 * @returns {ProjectAccessError}
 */
export function toProjectAccessError(err) {
  if (err instanceof ProjectAccessError) return err;
  // gh-exec's message is generic; the refusal text is the stderr tail.
  const detail = describeGhFailure(err);
  return new ProjectAccessError(
    `GitHub Projects v2 board is not accessible with this token (missing the "${PROJECT_SCOPE}" scope?): ${detail}`,
    { cause: err },
  );
}

// Sinks already warned, keyed per logger instance; production shares one
// `Logger`, so once per process.
let warnedSinks = new WeakSet();

/** Forget every warned sink — test isolation within one process. */
export function resetBoardAccessLatch() {
  warnedSinks = new WeakSet();
}

/**
 * Record a board scope failure; the first call per process (per sink) emits
 * the one warning (stderr), later calls are silent.
 *
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {boolean} true when this call emitted the warning.
 */
export function reportBoardScopeFailure({ logger = Logger } = {}) {
  if (warnedSinks.has(logger)) return false;
  warnedSinks.add(logger);
  logger.warn?.(
    `GitHub Projects v2 board updates are failing: the token lacks the "${PROJECT_SCOPE}" scope, so board adds and Status flips are skipped (labels still move). Run \`${PROJECT_SCOPE_REMEDY}\`, then \`node .agents/scripts/board-backfill.js\` to catch the board up.`,
  );
  return true;
}

/**
 * Classify a board-call failure: a scope/auth refusal trips the latch and
 * yields the outcome fields to report; anything else yields null.
 *
 * @param {unknown} err
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {{ reason: 'insufficient-scope', scope: 'project' } | null}
 */
export function boardScopeFailure(err, { logger } = {}) {
  if (!isProjectAccessFailure(err)) return null;
  reportBoardScopeFailure({ logger });
  return SCOPE_FAILURE;
}
