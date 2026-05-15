/**
 * lib/orchestration/ticketing/bulk.js — Cascade + batch ticketing surface.
 *
 * Owns the multi-ticket, cross-parent operations: the cascade walk that
 * fires when a child ticket reaches `agent::done`, the per-parent
 * sequencing lock, the transient-error classifier and retry budget, and
 * the partial-failure log helper. Pulled out of `../ticketing.js` under
 * Story #1848 so the verb-family split (`reads` / `state` / `bulk`) is
 * complete and the parent collapses to a pure re-export facade.
 *
 * Note on the cycle with `./state.js`: `cascadeCompletion` recursively
 * calls `transitionTicketState`, which in turn — when the cascade flag is
 * on — calls back into `cascadeCompletion`. ESM tolerates the cycle
 * because every binding is resolved at call-time. Both modules complete
 * evaluation before any of their exported functions run.
 */

import { Logger } from '../../Logger.js';
import { TYPE_LABELS } from '../../label-constants.js';
import { concurrentMap } from '../../util/concurrent-map.js';
import { dispatchCascadeGroups, groupByAncestor } from '../cascade-grouping.js';
import { STATE_LABELS } from './reads.js';
import {
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
} from './state.js';

// Re-export `groupByAncestor` so external callers that imported it from
// the ticketing facade continue to work after the verb-family split.
export { groupByAncestor };

/**
 * Cap on concurrent sibling re-reads inside `cascadeCompletion`. Bounded to
 * keep wide tasklists (many siblings under one parent) from saturating the
 * provider's connection pool while still amortising network latency.
 */
const CASCADE_SIBLING_READ_CONCURRENCY = 8;

/**
 * Retry budget for transient `gh` failures (rate limit, secondary rate limit,
 * 5xx, transport timeouts) inside the cascade transition. Three attempts with
 * exponential backoff (250ms / 500ms / 1000ms) mirrors the budget used by
 * `gitFetchWithRetry` (see `lib/git-utils.js`) and the HTTP-client retry path
 * referenced by `epic-plan-decompose.js`. Backoff is overridable via
 * {@link __setCascadeRetryDelays} so tests don't pay real wall-clock time.
 */
const CASCADE_RETRY_BACKOFF_MS = [250, 500, 1000];
const defaultCascadeSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
let _cascadeRetryDelays = CASCADE_RETRY_BACKOFF_MS;
let _cascadeSleep = defaultCascadeSleep;

/**
 * Test seam — replace the backoff schedule and/or the sleep implementation
 * used by the cascade retry loop. Restore by calling with no arguments.
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
 * Per-parent serial lock used to prevent two concurrent cascades within the
 * same wave from racing the parent's "all children done?" check (Story
 * #1817). The map is keyed by parent issue number; entries are reclaimed
 * once the last awaiter finishes. The lock is scoped to a single Node
 * process — cross-process races (multiple worktrees closing in parallel)
 * still rely on the retry/idempotency path.
 *
 * @type {Map<number, Promise<unknown>>}
 */
const parentCascadeLocks = new Map();

/**
 * Acquire the per-parent cascade lock, run `fn`, then release. Awaiters
 * queue strictly in invocation order. Failures of prior holders do not
 * propagate — each acquirer sees a clean entry into `fn`.
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

/**
 * Test seam — clear the per-parent cascade lock map between tests so a
 * pending entry from one scenario does not leak into the next.
 */
export function __resetParentCascadeLocks() {
  parentCascadeLocks.clear();
}

/**
 * Classifies a thrown cascade error as "transient" (rate limit, secondary
 * rate limit, 5xx, transport timeout / reset) so the retry loop can back
 * off instead of surfacing the failure to the operator. Provider-agnostic:
 * matches on typed error names (`GhRateLimitError`), HTTP status, and
 * conservative regex over stderr + message.
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
 * Render a cascade-failure error into a single log-friendly string that
 * preserves stderr and exit-code context. The legacy log line collapsed
 * `gh-exec`-thrown errors to a bare "exit 1" message, which made the
 * failure mode unclassifiable post-hoc (see Story #1817).
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
 * Run `fn` with exponential backoff on transient errors. Non-transient
 * errors propagate immediately on the first attempt. The total attempt
 * count is `delays.length + 1` (one initial attempt plus one retry per
 * delay).
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
 * Emit a warn line for every per-parent cascade failure captured by
 * {@link cascadeCompletion}. Each `error` string is pre-formatted with
 * stderr + exit-code by `formatCascadeError`, so callers can pass the
 * raw envelope through without further wrapping. Called from
 * `state.js`'s `transitionTicketState` to keep its cyclomatic
 * complexity inside the project's per-method CRAP ceiling (Story #1817,
 * Story #1848).
 *
 * @param {number} ticketId  The ticket whose `agent::done` transition
 *                           triggered the cascade.
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
 * Per-parent body of {@link cascadeCompletion}. Pulled out so the outer
 * function can dispatch disjoint groups in parallel while each parent
 * still runs against its own captured logger, ensuring byte-identical
 * log output across serial and parallel execution paths.
 *
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
 * Body of {@link processCascadeParent} that runs under the per-parent lock.
 * Split out so the lock-acquire scaffolding stays a one-liner and the
 * cyclomatic complexity of the per-parent worker doesn't drift over the
 * project's CRAP ceiling once the retry / idempotency branches are added.
 *
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
    await toggleTasklistCheckbox(provider, parentId, ticketId, true);

    // Idempotency check (Story #1817): re-fetch the parent under the lock
    // so a concurrent cascade winner that already flipped this parent to
    // `agent::done` short-circuits us without re-running the transition.
    // The provider cache may still hold a stale row from before the
    // winner's PATCH — invalidate first when supported.
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

    const subTickets = await provider.getSubTickets(parentId);
    // Re-fetch each sibling with fresh reads before the all-done check.
    // `getSubTickets` populates each row via `getTicket`, which honors the
    // per-instance ticket cache — a stale CLOSED entry for a sibling that
    // has since been reopened (operator action, prior failed cascade) would
    // otherwise let the cascade close the parent while a sibling is still
    // open. Cache invalidation here is cheap (one HTTP read per sibling)
    // and only fires when the closing ticket itself reaches `agent::done`,
    // so the cost is bounded.
    //
    // The sibling-read fan-out is bounded via `concurrentMap` (cap=8) so a
    // wide tasklist does not saturate the provider's connection pool. The
    // mapper preserves input order and the per-row try/catch guarantees a
    // transient read failure falls back to the (possibly stale) row from
    // `getSubTickets` rather than rejecting the whole cascade.
    const freshSubTickets = await concurrentMap(
      subTickets,
      async (st) => {
        if (typeof provider.invalidateTicket === 'function') {
          try {
            provider.invalidateTicket(st.id);
          } catch {
            // Cache invalidation is best-effort — fall through to whatever
            // `getTicket` returns even if the invalidation hook throws.
          }
        }
        if (typeof provider.getTicket !== 'function') return st;
        try {
          return await provider.getTicket(st.id, { fresh: true });
        } catch {
          // A transient read failure must not silently flip the cascade
          // to "all done"; fall back to the (possibly stale) row from
          // `getSubTickets` so the existing label check still applies.
          return st;
        }
      },
      { concurrency: CASCADE_SIBLING_READ_CONCURRENCY },
    );
    const allDone = freshSubTickets.every(
      (st) => st.labels.includes(STATE_LABELS.DONE) || st.state === 'closed',
    );
    if (!allDone) return { cascadedTo, failed };

    // EXCLUSION: Epics and Planning tickets (PRDs, Tech Specs) do not
    // auto-close via cascade.
    //   - Epics close via formal /epic-deliver (their own machinery
    //     handles branch merges, version bumps, release tags).
    //   - Planning tickets (context::prd, context::tech-spec) close by
    //     operator once the Epic is finalized.
    //
    // Features, by contrast, DO auto-close via cascade. A Feature is a
    // purely hierarchical grouping — no standalone branch, no merge
    // step. When its last child Story closes, the Feature is complete
    // by definition. Operators who need Feature-level AC verification
    // should encode it in the final child Story, not rely on a manual
    // close step.
    const parent = await provider.getTicket(parentId);
    const isEpic = parent.labels.includes(TYPE_LABELS.EPIC);
    const isPlanning =
      parent.labels.includes('context::prd') ||
      parent.labels.includes('context::tech-spec');
    if (isEpic || isPlanning) {
      logger.warn(
        `[Ticketing] Cascade reached ${isEpic ? 'Epic' : 'Planning'} #${parentId}. Skipping auto-close (Epics close via the operator's PR merge; Planning tickets close manually post-merge).`,
      );
      return { cascadedTo, failed };
    }

    // Retry the parent transition on transient `gh` failures (rate limit,
    // 5xx, transport timeouts). Permanent failures fall through to the
    // outer catch on the first attempt so the operator sees the real
    // error rather than three retries' worth of noise.
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
 * Recursively cascade upward.
 * If ticket reaches DONE, it toggles its checkbox in its parent.
 * Then checks if parent's sub-tickets are ALL DONE.
 * If yes, transitions parent to DONE and cascades up.
 *
 * Parents are partitioned into disjoint groups by shared ancestor
 * ({@link groupByAncestor}). Groups run in parallel via `Promise.all`,
 * but parents **within** a group run strictly sequentially in input
 * order — concurrent transitions against a shared ancestor would race
 * the "all children done?" check. Within each parent, sibling re-reads
 * fan out via `concurrentMap` with a fixed cap (8) — see
 * `CASCADE_SIBLING_READ_CONCURRENCY`.
 *
 * Log output is captured per parent into a buffered logger and flushed
 * to the real {@link Logger} after all groups resolve, in the original
 * `parsedParents` order. The visible log stream is therefore
 * byte-identical to a serial baseline; only the I/O between parents in
 * disjoint groups overlaps.
 *
 * Per-parent errors are isolated: a failure updating one parent (network,
 * permission, stale ticket) never discards progress on sibling parents.
 * Failures are collected and returned so callers can log them with full
 * ticket context instead of seeing a single rejection.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {{ notify?: Function, _logger?: object }} [opts] - `notify` is
 *   forwarded to any recursive `transitionTicketState` fired on parent
 *   tickets. `_logger` is an internal hook used by nested cascade calls
 *   to keep buffered output coherent — external callers should leave it
 *   unset so the module-level {@link Logger} is used.
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
export async function cascadeCompletion(provider, ticketId, opts = {}) {
  const ticket = await provider.getTicket(ticketId);

  // Determine if this ticket is agent::done
  if (!ticket.labels.includes(STATE_LABELS.DONE)) {
    return { cascadedTo: [], failed: [] };
  }

  const { blocks: parentIds } = await provider.getTicketDependencies(ticketId);

  // Fallback: parse `parent: #NNN` from the body when `blocks` syntax isn't used (C-5).
  let parsedParents = parentIds;
  if (!parsedParents || parsedParents.length === 0) {
    const parentMatch = ticket.body
      ? [...ticket.body.matchAll(/parent:\s*#(\d+)/gi)]
      : [];
    parsedParents = parentMatch.map((m) => Number.parseInt(m[1], 10));
  }

  if (parsedParents.length === 0) {
    return { cascadedTo: [], failed: [] };
  }

  // Partition parents by shared ancestor (disjoint groups run in
  // parallel; within-group parents stay sequential to avoid racing the
  // shared ancestor's "all children done?" check), then dispatch the
  // per-parent work via `dispatchCascadeGroups` so the buffered-flush
  // bookkeeping lives in `cascade-grouping.js`.
  const groups = await groupByAncestor(parsedParents, provider);
  const results = await dispatchCascadeGroups({
    parsedParents,
    groups,
    flushLogger: opts._logger ?? Logger,
    processParent: (parentId, logger) =>
      processCascadeParent(provider, ticketId, parentId, {
        notify: opts.notify,
        _logger: logger,
      }),
  });

  const cascadedTo = [];
  const failed = [];
  for (const r of results) {
    cascadedTo.push(...r.cascadedTo);
    failed.push(...r.failed);
  }
  return { cascadedTo, failed };
}
