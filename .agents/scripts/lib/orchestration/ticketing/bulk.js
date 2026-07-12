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
 * Story #3995 — the single-ticket mutators (`transitionTicketState`,
 * `toggleTasklistCheckbox`, `postStructuredComment`) moved to the leaf
 * `./transition.js`, so this module now depends **downward** on
 * `transition.js` and the former `state.js ↔ bulk.js` import cycle is
 * gone. `cascadeCompletion` still recursively transitions parents via
 * the imported `transitionTicketState`; the reverse call
 * (`transitionTicketState → cascadeParentState`) is injected into
 * `transition.js` by `state.js` via `registerCascadeRunner` rather than
 * imported, which is what keeps the graph acyclic.
 */

import { Logger } from '../../Logger.js';
import { TYPE_LABELS } from '../../label-constants.js';
import { ALL_STATES, STATE_LABELS } from './reads.js';
import {
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
} from './transition.js';

/**
 * Retry budget for transient `gh` failures (rate limit, secondary rate limit,
 * 5xx, transport timeouts) inside the cascade transition. Three attempts with
 * exponential backoff (250ms / 500ms / 1000ms) mirrors the budget used by
 * `gitFetchWithRetry` (see `lib/git-utils.js`) and the HTTP-client retry path
 * referenced by the plan persist surface. Backoff is overridable via
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
 * walk stays a thin sequential loop while the per-parent work runs under
 * the per-parent cascade lock.
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
    await toggleTasklistCheckbox(provider, parentId, ticketId, {
      checked: true,
    });

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

    // Fetch siblings with fresh reads to defend against stale-CLOSED entries.
    // `{ fresh: true }` threads into the per-child `getTicket` inside
    // `getSubTickets`, bypassing the cache in one pass rather than two.
    // The per-child try/catch fallback-to-null is preserved by `getSubTickets`
    // itself, so a transient read failure cannot silently flip the all-done
    // check. The concurrency cap (SUBTICKET_HYDRATION_CONCURRENCY = 8) is
    // applied inside `getSubTickets`.
    const freshSubTickets = await provider.getSubTickets(parentId, {
      fresh: true,
    });
    const allDone = freshSubTickets.every(
      (st) => st.labels.includes(STATE_LABELS.DONE) || st.state === 'closed',
    );
    if (!allDone) return { cascadedTo, failed };

    // EXCLUSION: Epics do not auto-close via cascade. Epics close via
    // formal /deliver (its own machinery handles branch merges,
    // PR-driven `Closes #N` auto-close, and a recovery transition in
    // `epic-deliver-finalize.js`).
    //
    // Legacy planning tickets (pre-#4324 `context::*` artifacts on
    // historical Epics) DO close via cascade (Story #1951): leaving
    // them open as native sub-issues of the Epic blocks GitHub from
    // honoring the Epic's `Closes #N` footer. New Epics carry their
    // planning content on the Epic body itself, so this branch is
    // purely a legacy-hygiene path.
    //
    // Reuse the parentSnapshot from the idempotency check above — it is
    // a fresh read (cache was invalidated before the getTicket call) and
    // the parent's type label is invariant within a single cascade lock
    // hold, so a second getTicket is wasteful and redundant.
    const isEpic = parentSnapshot.labels.includes(TYPE_LABELS.EPIC);
    if (isEpic) {
      logger.warn(
        `[Ticketing] Cascade reached Epic #${parentId}. Skipping auto-close (Epics close via the operator's PR merge).`,
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
 * Parents run strictly sequentially in input order (Story #4017 —
 * fan-out is <= 1 under the 2-tier hierarchy, so the former
 * shared-ancestor grouping / parallel dispatch was deleted); concurrent
 * transitions against a shared ancestor would race the "all children
 * done?" check. Within each parent, sibling reads fan out via
 * `getSubTickets(parentId, { fresh: true })` with the concurrency cap
 * (8) applied inside `getSubTickets`.
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

  // Story #2982 — third fallback: GitHub's native Sub-Issues API. The
  // resume reconciler can strip the `parent: #N` orchestrator footer
  // from a Story body (see Issue 2 in #2982); without the body marker
  // the cascade silently returned `{ cascadedTo: [], failed: [] }` and
  // left intermediate parent tickets stranded OPEN. The native link is
  // independent of body text, so consult it when the first two
  // strategies came back empty.
  if (
    parsedParents.length === 0 &&
    typeof provider._getNativeParent === 'function' &&
    ticket.nodeId
  ) {
    try {
      const nativeParent = await provider._getNativeParent(
        ticket.nodeId,
        ticketId,
      );
      if (typeof nativeParent === 'number') {
        parsedParents = [nativeParent];
      }
    } catch (err) {
      Logger.warn(
        `[cascadeCompletion] native parent lookup failed for #${ticketId}: ${err.message}`,
      );
    }
  }

  if (parsedParents.length === 0) {
    return { cascadedTo: [], failed: [] };
  }

  // Story #4017 — under the 2-tier hierarchy a ticket has at most one
  // parent, so the shared-ancestor grouping / parallel-group dispatch
  // machinery was deleted. Parents (fan-out <= 1
  // in practice; the loop stays general for the body-reference fallback)
  // run strictly sequentially, which trivially preserves the
  // shared-ancestor safety invariant the grouping used to enforce.
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
 * Derive the parent `agent::*` state from the composition of its children.
 *
 * Rules (Story #2676):
 * - Any child carrying `agent::blocked` → parent should be `agent::blocked`.
 * - Otherwise, every child is `agent::done` (or closed) → parent should be
 *   `agent::done`.
 * - Otherwise, any child carrying `agent::executing` or `agent::closing` →
 *   parent should be `agent::executing`.
 * - Otherwise (e.g. all children still `agent::ready`) → return `null` to
 *   signal "leave the parent unchanged". A parent already partway through
 *   the lifecycle MUST NOT be downgraded just because one child reverted.
 *
 * The function is pure and exported so the rule can be exercised in
 * isolation by unit tests without dragging the cascade I/O surface in.
 *
 * @param {Array<{ labels?: string[], state?: string }>} siblings
 * @returns {string|null} A `STATE_LABELS.*` value, or `null` for no-op.
 */
export function deriveParentState(siblings) {
  if (!Array.isArray(siblings) || siblings.length === 0) return null;
  const labelsOf = (s) => (Array.isArray(s?.labels) ? s.labels : []);
  if (siblings.some((s) => labelsOf(s).includes(STATE_LABELS.BLOCKED))) {
    return STATE_LABELS.BLOCKED;
  }
  const allDone = siblings.every(
    (s) => labelsOf(s).includes(STATE_LABELS.DONE) || s?.state === 'closed',
  );
  if (allDone) return STATE_LABELS.DONE;
  const anyActive = siblings.some(
    (s) =>
      labelsOf(s).includes(STATE_LABELS.EXECUTING) ||
      labelsOf(s).includes(STATE_LABELS.CLOSING),
  );
  if (anyActive) return STATE_LABELS.EXECUTING;
  return null;
}

/**
 * Parent-state cascade for non-terminal transitions. Story #2676.
 *
 * When a child ticket transitions to any `agent::*` state, this function
 * walks the parent chain and updates each parent's state to the value
 * derived by {@link deriveParentState} — so that moving a Task to
 * `agent::executing` propagates "in progress" up to the Story and the
 * Epic on the Project board, and moving a Task to `agent::blocked`
 * surfaces the HITL signal at every ancestor.
 *
 * For `agent::done` transitions, propagation is delegated to the
 * existing {@link cascadeCompletion} so the long-standing semantics
 * (tasklist checkbox toggling, the "All child tickets completed via
 * recursive cascade" progress comment, Epic exclusion) are preserved
 * verbatim.
 *
 * Resilience matches {@link cascadeCompletion}: parents run
 * sequentially; the per-parent lock from {@link withParentCascadeLock}
 * prevents races on shared ancestors; and per-parent errors are
 * isolated so a sibling parent's failure does not discard work on the
 * others.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {{ notify?: Function, _logger?: object }} [opts]
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
export async function cascadeParentState(provider, ticketId, opts = {}) {
  // Provider-capability guard. Cascade derivation needs both
  // `getTicketDependencies` (to walk the `blocks:` parent edge) and
  // `getSubTickets` (to inspect the parent's children). Test fakes
  // that stub only the single-ticket surface (e.g. the column-sync
  // sibling tests) MUST still be able to drive `transitionTicketState`
  // without the cascade blowing up. Silently no-op when the surface
  // is missing — propagation is best-effort, matching the contract
  // already documented for the column-sync mirror.
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

  // DONE-cascade keeps the existing path: tasklist checkbox toggle,
  // progress comment, Epic-close exclusion, and the legacy log shape are
  // all encoded in `cascadeCompletion` and externally observed by tests.
  if (childState === STATE_LABELS.DONE) {
    return cascadeCompletion(provider, ticketId, opts);
  }

  const parsedParents = await resolveParentIds(provider, ticket, ticketId);
  if (parsedParents.length === 0) return { cascadedTo: [], failed: [] };

  // Story #4017 — sequential per-parent walk (fan-out <= 1 under the
  // 2-tier hierarchy); see cascadeCompletion for the rationale.
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
 * Resolve the parent issue ids for a ticket: native `blocks:` dependency
 * annotations first, then `parent: #NNN` body references as a fallback.
 * Mirrors the resolution path used by {@link cascadeCompletion}.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {object} ticket
 * @param {number} ticketId
 * @returns {Promise<number[]>}
 */
async function resolveParentIds(provider, ticket, ticketId) {
  const { blocks: parentIds } = await provider.getTicketDependencies(ticketId);
  if (Array.isArray(parentIds) && parentIds.length > 0) return parentIds;
  const parentMatch = ticket?.body
    ? [...ticket.body.matchAll(/parent:\s*#(\d+)/gi)]
    : [];
  return parentMatch.map((m) => Number.parseInt(m[1], 10));
}

/**
 * Per-parent worker for {@link cascadeParentState}. Acquires the shared
 * per-parent cascade lock so concurrent transitions on sibling children
 * cannot race on the parent's derived-state check.
 *
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
async function processStateCascadeParent(provider, parentId, opts) {
  const logger = opts._logger ?? Logger;
  return withParentCascadeLock(parentId, () =>
    processStateCascadeParentLocked(provider, parentId, opts, logger),
  );
}

/**
 * Body of {@link processStateCascadeParent} under the per-parent lock.
 * Computes the derived state from a fresh sibling read, applies the
 * idempotency guard, and recurses upward.
 */
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
    // Fetch siblings fresh in one pass — `{ fresh: true }` threads into the
    // per-child `getTicket` inside `getSubTickets`, replacing the previous
    // two-step pattern of `getSubTickets` + a second `concurrentMap` fan-out
    // with `invalidateTicket` + `getTicket(id, { fresh:true })`.
    const freshSubs = await provider.getSubTickets(parentId, { fresh: true });

    const derived = deriveParentState(freshSubs);
    if (derived === null) return { cascadedTo, failed };

    // Defer the all-done case to the legacy DONE-cascade so it
    // owns the Epic exclusion, the tasklist toggle, the progress
    // comment, and the recursive walk that already pin its
    // behaviour via the existing test surface. The closing child's
    // id is taken from `freshSubs` — any DONE child suffices because
    // cascadeCompletion only uses the child to look up its parents.
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
      // Idempotency guard — Project board is already in the derived
      // column. Skip the transition entirely so we do not burn a
      // GraphQL write for a no-op.
      return { cascadedTo, failed };
    }

    await retryTransient(
      () =>
        transitionTicketState(provider, parentId, derived, {
          notify: opts.notify,
          // Recursion is handled explicitly below — passing cascade:false
          // prevents state.js from firing its own cascadeParentState on the
          // parent and double-walking the tree.
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
