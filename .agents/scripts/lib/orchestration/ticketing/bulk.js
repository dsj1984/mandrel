/**
 * lib/orchestration/ticketing/bulk.js — Cascade + batch ticketing surface:
 * the upward cascade walk, the per-parent lock, and transient-error retry.
 * Depends downward on `./transition.js`; the reverse edge is injected via
 * `registerCascadeRunner`, keeping the import graph acyclic.
 */

import { Logger } from '../../Logger.js';
import { ALL_STATES, STATE_LABELS } from './reads.js';
import {
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
} from './transition.js';

/** Backoff for transient `gh` failures inside the cascade transition. */
const CASCADE_RETRY_BACKOFF_MS = [250, 500, 1000];
const defaultCascadeSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
let _cascadeRetryDelays = CASCADE_RETRY_BACKOFF_MS;
let _cascadeSleep = defaultCascadeSleep;

/**
 * Test seam; call with no arguments to restore defaults.
 *
 * @param {{ delays?: number[], sleep?: (ms: number) => Promise<void> }} [opts]
 */
export function __setCascadeRetryDelays(opts = {}) {
  _cascadeRetryDelays = Array.isArray(opts.delays)
    ? opts.delays
    : CASCADE_RETRY_BACKOFF_MS;
  _cascadeSleep =
    typeof opts.sleep === 'function' ? opts.sleep : defaultCascadeSleep;
}

/**
 * Per-parent serial lock so concurrent cascades cannot race the parent's
 * "all children done?" check. In-process only; cross-process races rely on
 * the retry/idempotency path.
 *
 * @type {Map<number, Promise<unknown>>}
 */
const parentCascadeLocks = new Map();

/**
 * Awaiters queue in invocation order; a prior holder's failure does not
 * propagate to the next.
 *
 * @template R
 * @param {number} parentId
 * @param {() => Promise<R>} fn
 * @returns {Promise<R>}
 */
async function withParentCascadeLock(parentId, fn) {
  const prev = parentCascadeLocks.get(parentId) ?? Promise.resolve();
  const current = prev.then(
    () => fn(),
    () => fn(),
  );
  parentCascadeLocks.set(parentId, current);
  try {
    return await current;
  } finally {
    if (parentCascadeLocks.get(parentId) === current) {
      parentCascadeLocks.delete(parentId);
    }
  }
}

export function __resetParentCascadeLocks() {
  parentCascadeLocks.clear();
}

/**
 * Rate limit, 5xx, or transport failure — worth a backoff retry.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientCascadeError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'GhRateLimitError') return true;
  const status = typeof err.status === 'number' ? err.status : null;
  if (status === 429) return true;
  if (status !== null && status >= 500) return true;
  const haystack = `${err.message ?? ''}\n${err.stderr ?? ''}`.toLowerCase();
  if (
    /secondary rate limit|api rate limit exceeded|rate limit exceeded/.test(
      haystack,
    )
  )
    return true;
  if (/abuse detection/.test(haystack)) return true;
  if (/econnreset|etimedout|enotfound|eai_again|abort_err/.test(haystack))
    return true;
  if (/timed out|timeout|aborted|fetch failed|network/.test(haystack))
    return true;
  return false;
}

/**
 * One-line rendering that keeps stderr and exit code, so a failure stays
 * classifiable after the fact.
 *
 * @param {unknown} err
 * @returns {string}
 */
function formatCascadeError(err) {
  if (!err) return 'unknown error';
  if (typeof err !== 'object') return String(err);
  const parts = [];
  if (err.name && err.name !== 'Error') parts.push(`${err.name}`);
  if (err.message) parts.push(err.message);
  if (typeof err.code === 'number') parts.push(`exit=${err.code}`);
  if (typeof err.status === 'number') parts.push(`http=${err.status}`);
  if (typeof err.stderr === 'string' && err.stderr.trim()) {
    const trimmed = err.stderr.trim().replace(/\s+/g, ' ');
    const capped = trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
    parts.push(`stderr=${capped}`);
  }
  return parts.join(' | ') || String(err);
}

/**
 * Retry `fn` on transient errors only; attempts = `delays.length + 1`.
 *
 * @template R
 * @param {() => Promise<R>} fn
 * @param {{ onRetry?: (err: unknown, attempt: number, delayMs: number) => void }} [opts]
 * @returns {Promise<R>}
 */
async function retryTransient(fn, opts = {}) {
  const delays = _cascadeRetryDelays;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientCascadeError(err)) throw err;
      if (attempt >= delays.length) throw err;
      const delay = delays[attempt];
      if (typeof opts.onRetry === 'function') {
        try {
          opts.onRetry(err, attempt + 1, delay);
        } catch {
          // listener failures must not abort the retry
        }
      }
      await _cascadeSleep(delay);
      attempt += 1;
    }
  }
}

/**
 * @param {number} ticketId  The ticket whose transition triggered the cascade.
 * @param {{ failed?: Array<{ parentId: number, error: string }> } | null} cascade
 */
export function logCascadePartialFailures(ticketId, cascade) {
  const cascadeFailures = cascade?.failed ?? [];
  for (const { parentId, error } of cascadeFailures) {
    Logger.warn(
      `[Ticketing] Cascade from #${ticketId} hit partial-failure on parent #${parentId}: ${error}`,
    );
  }
}

/**
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId  - The ticket whose `agent::done` transition
 *                             triggered the cascade.
 * @param {number} parentId  - The parent currently being processed.
 * @param {{ notify?: Function, _logger?: object }} opts
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }>, error?: Error }>}
 */
async function processCascadeParent(provider, ticketId, parentId, opts) {
  const logger = opts._logger ?? Logger;
  return withParentCascadeLock(parentId, () =>
    processCascadeParentLocked(provider, ticketId, parentId, opts, logger),
  );
}

/**
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
async function processCascadeParentLocked(
  provider,
  ticketId,
  parentId,
  opts,
  logger,
) {
  const cascadedTo = [];
  const failed = [];
  try {
    await toggleTasklistCheckbox(provider, parentId, ticketId, {
      checked: true,
    });

    // Idempotency: re-read the parent under the lock (cache invalidated
    // first) so a concurrent winner that already flipped it short-circuits us.
    if (typeof provider.invalidateTicket === 'function') {
      try {
        provider.invalidateTicket(parentId);
      } catch {
        // best-effort cache invalidation
      }
    }
    const parentSnapshot = await provider.getTicket(parentId);
    if (parentSnapshot?.labels?.includes(STATE_LABELS.DONE)) {
      logger.debug(
        `[Ticketing] Cascade to parent #${parentId} skipped: already agent::done (concurrent winner).`,
      );
      return { cascadedTo, failed };
    }

    // Fresh sibling reads defend against stale-CLOSED cache entries.
    const freshSubTickets = await provider.getSubTickets(parentId, {
      fresh: true,
    });
    const allDone = freshSubTickets.every(
      (st) => st.labels.includes(STATE_LABELS.DONE) || st.state === 'closed',
    );
    if (!allDone) return { cascadedTo, failed };

    await retryTransient(
      () =>
        transitionTicketState(provider, parentId, STATE_LABELS.DONE, {
          notify: opts.notify,
        }),
      {
        onRetry: (err, attempt, delayMs) => {
          logger.warn(
            `[Ticketing] Cascade to parent #${parentId} hit transient ${err?.name ?? 'error'} ` +
              `(attempt ${attempt}); retrying in ${delayMs}ms. ${formatCascadeError(err)}`,
          );
        },
      },
    );
    await postStructuredComment(
      provider,
      parentId,
      'progress',
      'All child tickets completed via recursive cascade.',
    );
    cascadedTo.push(parentId);

    const nested = await cascadeCompletion(provider, parentId, {
      notify: opts.notify,
      _logger: logger,
    });
    cascadedTo.push(...nested.cascadedTo);
    failed.push(...nested.failed);
  } catch (err) {
    const detail = formatCascadeError(err);
    failed.push({ parentId, error: detail });
    logger.warn(`[Ticketing] Cascade to parent #${parentId} failed: ${detail}`);
  }
  return { cascadedTo, failed };
}

/**
 * When a ticket is `agent::done`, tick its checkbox in each parent and, if
 * all the parent's children are done, transition the parent and recurse.
 * Parents run sequentially (a shared ancestor would race the all-done
 * check); per-parent failures are collected, never discarding sibling work.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {{ notify?: Function, _logger?: object }} [opts] - `_logger` is for
 *   nested calls only.
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
async function cascadeCompletion(provider, ticketId, opts = {}) {
  const ticket = await provider.getTicket(ticketId);

  if (!ticket.labels.includes(STATE_LABELS.DONE)) {
    return { cascadedTo: [], failed: [] };
  }

  // The operator-settable `blocks` annotation is the only parent edge.
  const { blocks: parentIds } = await provider.getTicketDependencies(ticketId);
  const parsedParents = Array.isArray(parentIds) ? parentIds : [];

  if (parsedParents.length === 0) {
    return { cascadedTo: [], failed: [] };
  }

  const cascadedTo = [];
  const failed = [];
  for (const parentId of parsedParents) {
    const r = await processCascadeParent(provider, ticketId, parentId, {
      notify: opts.notify,
      _logger: opts._logger,
    });
    cascadedTo.push(...r.cascadedTo);
    failed.push(...r.failed);
  }
  return { cascadedTo, failed };
}

/**
 * Labels describing live work on a child — empty for a closed child, whose
 * stale `agent::*` label records where it stopped, not outstanding work.
 *
 * Module-level rather than a local arrow: the CRAP baseline keys anonymous
 * functions positionally, so adding one inside `deriveParentState` would
 * renumber later arrows and fake drift.
 *
 * @param {{ labels?: string[], state?: string }} sibling
 * @returns {string[]}
 */
function liveChildLabels(sibling) {
  if (sibling?.state === 'closed') return [];
  return Array.isArray(sibling?.labels) ? sibling.labels : [];
}

/**
 * Derive a parent's `agent::*` state from its children: any open blocked →
 * blocked; else all done-or-closed → done; else any open executing/closing →
 * executing; else `null` (never downgrade a parent). Closed children vote
 * only as done — a stale `agent::blocked` on a superseded child must not
 * pin its Epic open.
 *
 * @param {Array<{ labels?: string[], state?: string }>} siblings
 * @returns {string|null} A `STATE_LABELS.*` value, or `null` for no-op.
 */
export function deriveParentState(siblings) {
  if (!Array.isArray(siblings) || siblings.length === 0) return null;
  const labelsOf = (s) => (Array.isArray(s?.labels) ? s.labels : []);
  if (siblings.some((s) => liveChildLabels(s).includes(STATE_LABELS.BLOCKED))) {
    return STATE_LABELS.BLOCKED;
  }
  const allDone = siblings.every(
    (s) => labelsOf(s).includes(STATE_LABELS.DONE) || s?.state === 'closed',
  );
  if (allDone) return STATE_LABELS.DONE;
  const anyActive = siblings.some(
    (s) =>
      liveChildLabels(s).includes(STATE_LABELS.EXECUTING) ||
      liveChildLabels(s).includes(STATE_LABELS.CLOSING),
  );
  if (anyActive) return STATE_LABELS.EXECUTING;
  return null;
}

/**
 * "Finished" is not "landed": a cohort closed wholly as superseded derives
 * `done` but delivered nothing. One landed child means the container
 * completed; none means `not_planned`.
 *
 * @param {Array<{ labels?: string[] }>} children
 * @returns {boolean} True when at least one child carries `agent::done`.
 */
export function anyChildLanded(children) {
  if (!Array.isArray(children)) return false;
  return children.some((child) =>
    (Array.isArray(child?.labels) ? child.labels : []).includes(
      STATE_LABELS.DONE,
    ),
  );
}

/**
 * Propagate any `agent::*` transition up the parent chain using
 * {@link deriveParentState}; `done` delegates to {@link cascadeCompletion}.
 * Same sequential, locked, failure-isolated walk.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {{ notify?: Function, _logger?: object }} [opts]
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
export async function cascadeParentState(provider, ticketId, opts = {}) {
  // Best-effort: providers lacking the dependency/sub-ticket surface no-op.
  if (
    typeof provider?.getTicketDependencies !== 'function' ||
    typeof provider?.getSubTickets !== 'function'
  ) {
    return { cascadedTo: [], failed: [] };
  }
  const ticket = await provider.getTicket(ticketId);
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  const childState = labels.find((l) => ALL_STATES.includes(l));
  if (!childState) return { cascadedTo: [], failed: [] };

  if (childState === STATE_LABELS.DONE) {
    return cascadeCompletion(provider, ticketId, opts);
  }

  const parsedParents = await resolveParentIds(provider, ticket, ticketId);
  if (parsedParents.length === 0) return { cascadedTo: [], failed: [] };

  const cascadedTo = [];
  const failed = [];
  for (const parentId of parsedParents) {
    const r = await processStateCascadeParent(provider, parentId, {
      notify: opts.notify,
      _logger: opts._logger,
    });
    cascadedTo.push(...r.cascadedTo);
    failed.push(...r.failed);
  }
  return { cascadedTo, failed };
}

/**
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {object} _ticket
 * @param {number} ticketId
 * @returns {Promise<number[]>}
 */
async function resolveParentIds(provider, _ticket, ticketId) {
  const { blocks: parentIds } = await provider.getTicketDependencies(ticketId);
  return Array.isArray(parentIds) ? parentIds : [];
}

/**
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
async function processStateCascadeParent(provider, parentId, opts) {
  const logger = opts._logger ?? Logger;
  return withParentCascadeLock(parentId, () =>
    processStateCascadeParentLocked(provider, parentId, opts, logger),
  );
}

async function processStateCascadeParentLocked(
  provider,
  parentId,
  opts,
  logger,
) {
  const cascadedTo = [];
  const failed = [];
  try {
    if (typeof provider.invalidateTicket === 'function') {
      try {
        provider.invalidateTicket(parentId);
      } catch {
        // best-effort cache invalidation
      }
    }
    const freshSubs = await provider.getSubTickets(parentId, { fresh: true });

    const derived = deriveParentState(freshSubs);
    if (derived === null) return { cascadedTo, failed };

    // All-done defers to the DONE cascade; any done child suffices since it
    // is only used to look up the parents.
    if (derived === STATE_LABELS.DONE) {
      const doneChild = freshSubs.find(
        (s) => Array.isArray(s?.labels) && s.labels.includes(STATE_LABELS.DONE),
      );
      if (!doneChild) return { cascadedTo, failed };
      const nested = await cascadeCompletion(provider, doneChild.id, {
        notify: opts.notify,
        _logger: logger,
      });
      cascadedTo.push(...nested.cascadedTo);
      failed.push(...nested.failed);
      return { cascadedTo, failed };
    }

    const parent = await provider.getTicket(parentId);
    const parentLabels = Array.isArray(parent?.labels) ? parent.labels : [];
    const currentState = parentLabels.find((l) => ALL_STATES.includes(l));
    if (currentState === derived) {
      return { cascadedTo, failed };
    }

    await retryTransient(
      () =>
        transitionTicketState(provider, parentId, derived, {
          notify: opts.notify,
          // Recursion is explicit below; avoid double-walking the tree.
          cascade: false,
        }),
      {
        onRetry: (err, attempt, delayMs) => {
          logger.warn(
            `[Ticketing] State cascade to parent #${parentId} hit transient ${err?.name ?? 'error'} ` +
              `(attempt ${attempt}); retrying in ${delayMs}ms. ${formatCascadeError(err)}`,
          );
        },
      },
    );
    cascadedTo.push(parentId);

    const nested = await cascadeParentState(provider, parentId, {
      notify: opts.notify,
      _logger: logger,
    });
    cascadedTo.push(...nested.cascadedTo);
    failed.push(...nested.failed);
  } catch (err) {
    const detail = formatCascadeError(err);
    failed.push({ parentId, error: detail });
    logger.warn(
      `[Ticketing] State cascade to parent #${parentId} failed: ${detail}`,
    );
  }
  return { cascadedTo, failed };
}
