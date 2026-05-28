/**
 * lib/orchestration/ticketing/state.js — Per-ticket state mutators.
 *
 * Owns the one-ticket-at-a-time mutation surface: state-label
 * transitions, tasklist checkbox toggling, and structured-comment
 * post/upsert. Pulled out of `../ticketing.js` under Story #1848 so
 * the read-side (`./reads.js`) and the cascade/bulk side (`./bulk.js`)
 * each live behind a narrower import contract.
 *
 * Note on the cycle: `transitionTicketState` fires `cascadeCompletion`
 * from `./bulk.js` whenever a ticket flips to `agent::done` with the
 * default `cascade: true`. `./bulk.js` in turn imports
 * `transitionTicketState` to walk the parent chain. ESM tolerates the
 * cycle because neither side dereferences the other at
 * module-evaluation time — both bindings are resolved at call-time
 * once both modules have completed evaluation.
 */

import { extractEpicIdFromBody } from '../../dependency-parser.js';
import { Logger } from '../../Logger.js';
import {
  eventSeverity,
  renderTransitionMessage,
} from '../../notifications/notifier.js';
import { ColumnSync } from '../column-sync.js';
// Story #1848 — cascade primitives live in `./bulk.js`. The ESM cycle
// between state.js ↔ bulk.js is safe because neither side dereferences
// the imported bindings at module-evaluation time — both are invoked at
// call-time once the cycle has fully resolved. Story #2676 — the entry
// point for upward propagation is now `cascadeParentState`, which
// delegates `agent::done` transitions to `cascadeCompletion` internally.
import { cascadeParentState, logCascadePartialFailures } from './bulk.js';
import {
  ALL_STATES,
  assertValidStructuredCommentType,
  findStructuredComment,
  getProviderCommentCache,
  invalidateRawCommentsCache,
  STATE_LABELS,
  structuredCommentCacheKey,
  structuredCommentMarker,
} from './reads.js';

/**
 * Guard the inputs to {@link transitionTicketState}. Extracted from the
 * outer function so that the per-method cyclomatic complexity of
 * `transitionTicketState` lands below the CRAP-12 ceiling required by
 * Story #1848 (was CRAP 16 prior to the split — see baselines/crap.json).
 *
 * Currently a single label-membership predicate, but extracting it as a
 * named function lets future input guards (e.g. provider-shape checks,
 * concurrency-token validation) accrete here without re-inflating the
 * caller's complexity.
 *
 * @param {string} newState - Target `agent::*` label.
 * @returns {string} The validated newState, returned for fluent reuse.
 * @throws {Error} when `newState` is not a recognised state label.
 */
function validateTransitionInputs(newState) {
  if (!ALL_STATES.includes(newState)) {
    throw new Error(`Invalid state: ${newState}`);
  }
  return newState;
}

/**
 * Resolve the pre-transition ticket snapshot that drives the notify
 * payload and the provider's label-merge path. Honors the caller-supplied
 * `opts.ticketSnapshot` (Story #1795) when present; otherwise issues a
 * best-effort `getTicket` and returns `null` on transient failure.
 *
 * @param {object} provider
 * @param {{ notify?: Function, ticketSnapshot?: object|null }} opts
 * @param {number} ticketId
 * @returns {Promise<object|null>}
 */
async function loadTicketSnapshot(provider, opts, ticketId) {
  if (opts.ticketSnapshot) return opts.ticketSnapshot;
  if (!opts.notify || typeof provider.getTicket !== 'function') return null;
  try {
    return await provider.getTicket(ticketId);
  } catch (err) {
    Logger.debug(
      `[Ticketing] fromState lookup failed for #${ticketId}: ${err.message ?? err}`,
    );
    return null;
  }
}

/**
 * Mirror the post-flip label set onto the GitHub Projects v2 Status
 * column. Story #2548 — wiring this here makes every caller of
 * `transitionTicketState` (story-init, story-close, story-phase,
 * the LabelTransitioner lifecycle listener, the update-ticket-state CLI,
 * batch transitions) update the board automatically. Prior to #2548 the
 * sync was only wired from the epic-runner against the Epic ticket, so
 * Stories and Tasks never had their `agent::executing` /
 * `agent::blocked` flips reflected on the board.
 *
 * Best-effort: a project-board misconfig, missing scope, or transient
 * GraphQL failure MUST NOT block the label transition itself. Errors
 * surface via `Logger.warn` and the function resolves cleanly.
 *
 * @param {object} provider
 * @param {number} ticketId
 * @param {string} newState
 */
async function syncProjectStatusColumn(provider, ticketId, newState) {
  try {
    const sync = new ColumnSync({ provider, logger: Logger });
    await sync.sync(ticketId, [newState]);
  } catch (err) {
    Logger.warn(
      `[Ticketing] column sync failed for #${ticketId} → ${newState}: ${err?.message ?? err}`,
    );
  }
}

/**
 * Dispatch the state-transition notification once the label flip has
 * landed. Pulled out of `transitionTicketState` so the outer function
 * stays below the CRAP-12 ceiling: this is where the severity gating,
 * the ticket-type derivation, the level mapping, and the fire-and-forget
 * dispatch all live.
 *
 * @param {{
 *   notify: Function,
 *   ticketId: number,
 *   ticketSnapshot: object|null,
 *   fromState: string|null,
 *   newState: string,
 * }} args
 */
function dispatchTransitionNotification(args) {
  const { notify, ticketId, ticketSnapshot, fromState, newState } = args;
  const typeLabel =
    ticketSnapshot?.labels?.find((l) => l.startsWith('type::')) ?? '';
  const ticketType = typeLabel.replace(/^type::/, '') || 'ticket';
  const epicId = extractEpicIdFromBody(ticketSnapshot?.body) ?? null;
  const event = {
    kind: 'state-transition',
    ticket: {
      id: ticketId,
      title: ticketSnapshot?.title,
      type: ticketType,
    },
    fromState,
    toState: newState,
  };
  const severity = eventSeverity(event);
  // Suppress the dispatch entirely for low-severity transitions (task-
  // level, or non-terminal story / epic flips). Pre-migration the
  // comment channel filtered these out via `commentMinLevel: medium`;
  // post-migration the channel is event-allowlist gated and would
  // surface every transition equally, so the noise filter moves to
  // the emit point.
  if (severity === 'low') return;
  const message = renderTransitionMessage(event);
  // Post to the epic so operators get a single timeline feed; fall back
  // to the transitioned ticket itself when no epic reference is present.
  // The dispatch is fire-and-forget by design (a failed notification must
  // not block the state transition itself), but surfacing the failure via
  // the logger preserves operator visibility — the previous empty-handler
  // .catch swallowed network blips and webhook 5xxs without any signal.
  const targetId = epicId ?? ticketId;
  const level =
    ticketType === 'epic' || ticketType === 'wave' || ticketType === 'story'
      ? ticketType
      : 'task';
  Promise.resolve(
    notify(targetId, {
      severity,
      message,
      event: 'state-transition',
      level,
      epicId: epicId ?? undefined,
    }),
  ).catch((err) => {
    Logger.warn(
      `[Ticketing] notify dispatch failed for #${targetId}: ${err?.message ?? err}`,
    );
  });
}

/**
 * Transitions a ticket's label to the new state.
 * Removes other agent:: state labels.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} newState - Must be one of STATE_LABELS.
 * @param {{ notify?: Function, cascade?: boolean, ticketSnapshot?: object }} [opts]
 *   Optional notify function (the exported `notify(ticketId, payload, opts)`
 *   from `notify.js`, or any stub matching its shape). When provided, a
 *   state-transition notification fires after a successful transition.
 *   Story/Epic → `agent::done` events are dispatched as `medium`; all other
 *   transitions are `low` and filtered out at the default `medium` channel
 *   thresholds. The dispatched payload carries the typed envelope fields
 *   (`event: 'state-transition'`, `level: 'task'|'story'|'wave'|'epic'`,
 *   `epicId`) for routable webhook subscribers.
 *
 *   `cascade` (default `true`) controls whether a `done` transition fans the
 *   `cascadeCompletion` upward to parents. Per-Task closes invoked mid-Story
 *   from the retired per-Task progress writer (4-tier era, removed under
 *   #3157) passed `cascade: false` so the Story/Epic only flipped to
 *   `agent::done` at story-close (after the merge lands), not when the
 *   last Task commit landed on the still-unmerged Story branch. The
 *   parameter is preserved for callers that still suppress cascade
 *   explicitly (e.g. batch-transition helpers).
 *
 *   `ticketSnapshot` (Story #1795 / Epic #1788) is an optional pre-fetched
 *   ticket object. When the caller already holds the ticket (e.g.
 *   `batchTransitionTickets`, which loops over a list it just hydrated),
 *   passing the snapshot eliminates the two `getTicket` round-trips that
 *   `transitionTicketState` would otherwise issue — one for the notify
 *   `fromState` lookup and one inside `provider.updateTicket`'s label
 *   merge path. Backwards compatible: when omitted, behaviour is unchanged.
 */
export async function transitionTicketState(
  provider,
  ticketId,
  newState,
  opts = {},
) {
  validateTransitionInputs(newState);

  const toRemove = ALL_STATES.filter((state) => state !== newState);

  // Snapshot prior state for the notification payload (best-effort; skip on
  // error). A transient read failure MUST NOT block a label transition —
  // the transition itself is idempotent and `fromState: null` is a valid
  // payload value.
  //
  // Story #1795 — when the caller threads `opts.ticketSnapshot` we reuse
  // it as the notify snapshot without issuing a fresh `getTicket`. The
  // snapshot is also forwarded to `provider.updateTicket` so the label
  // merge path skips its own `getTicket` call (the second of the two
  // round-trips this seam eliminates).
  const ticketSnapshot = await loadTicketSnapshot(provider, opts, ticketId);
  const fromState =
    ticketSnapshot?.labels?.find((l) => ALL_STATES.includes(l)) ?? null;

  // Closing/reopening mirrors the label state so GitHub shows the correct
  // issue state without requiring a separate manual close step.
  const isDone = newState === STATE_LABELS.DONE;

  await provider.updateTicket(ticketId, {
    labels: {
      add: [newState],
      remove: toRemove,
    },
    state: isDone ? 'closed' : 'open',
    state_reason: isDone ? 'completed' : null,
    // Internal-only escape hatch threaded through `provider.updateTicket`
    // to `_applyLabelMutations`. Honored by `providers/github.js`; ignored
    // by providers that don't recognise it. Underscore-prefixed to mark
    // it as a provider-internal contract rather than part of the public
    // `mutations` shape.
    _ticketSnapshot: ticketSnapshot,
  });

  // Story #2548 — mirror the new state onto the Projects v2 Status
  // column. Best-effort; never blocks the transition.
  await syncProjectStatusColumn(provider, ticketId, newState);

  // Automatically trigger upward cascade on every transition (Story
  // #2676). The unified entry point is `cascadeParentState`, which:
  //   - delegates `agent::done` transitions to the legacy
  //     `cascadeCompletion` (preserving tasklist-checkbox toggling, the
  //     "All child tickets completed" progress comment, and the Epic
  //     close-exclusion);
  //   - for every other `agent::*` transition (`executing`, `blocked`,
  //     `closing`, …) walks the parent chain and updates each parent to
  //     the state derived from its children's current composition. This
  //     keeps the GitHub Project board accurate when work begins on a
  //     Task ("In Progress" surfaces up to the Story and Epic) or when a
  //     child enters the HITL pause state.
  //
  // Callers that intentionally suppress propagation (historically the
  // per-Task progress writer, which closed Tasks at commit-time but
  // deferred the Story flip to story-close after the branch was merged)
  // opt out by passing `cascade: false`.
  if (opts.cascade !== false) {
    const cascade = await cascadeParentState(provider, ticketId, {
      notify: opts.notify,
    });
    logCascadePartialFailures(ticketId, cascade);
  }

  // Fire the state-transition notification (fire-and-forget).
  if (typeof opts.notify === 'function') {
    dispatchTransitionNotification({
      notify: opts.notify,
      ticketId,
      ticketSnapshot,
      fromState,
      newState,
    });
  }
}

/**
 * Transition a Story ticket directly to a new `agent::*` state without
 * walking a Task cascade. Story #3097 (Wave-0 additive, Epic #3078
 * Strategy B) — in the 3-tier hierarchy a Story has no Task children, so
 * the canonical `transitionTicketState` upward-cascade path
 * (`cascadeParentState`) is the only meaningful walk. This helper is a
 * thin wrapper that pins `cascade: true` (so the parent Feature/Epic
 * still receives derived-state updates) and is intentionally a no-op
 * difference from `transitionTicketState` in 4-tier mode — the helper
 * exists so 3-tier callers can opt into a name that documents intent
 * (and so F8 can pivot the implementation to skip the now-impossible
 * Task-fan-in without rewriting call sites). The wrapper preserves every
 * `opts` field the caller supplies; only `cascade` defaults to `true`
 * when omitted.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} storyId
 * @param {string} newState - Must be one of STATE_LABELS.
 * @param {{ notify?: Function, cascade?: boolean, ticketSnapshot?: object }} [opts]
 */
export async function transitionStoryDirect(
  provider,
  storyId,
  newState,
  opts = {},
) {
  const merged = { cascade: true, ...opts };
  await transitionTicketState(provider, storyId, newState, merged);
}

/**
 * Mutates the tasklist checkbox in the parent's body.
 * E.g., `- [ ] #123` to `- [x] #123`
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId - ID of parent ticket
 * @param {number} subIssueId - ID of child ticket
 * @param {boolean} checked
 */
export async function toggleTasklistCheckbox(
  provider,
  ticketId,
  subIssueId,
  checked,
) {
  const ticket = await provider.getTicket(ticketId);
  const body = ticket.body || '';

  if (!body.includes(`#${subIssueId}`)) {
    return; // sub-issue not directly referenced in body
  }

  const targetBox = checked ? '- [x]' : '- [ ]';

  let newBody = body;

  if (checked) {
    // replace `- [ ] #123` or `- [] #123` with `- [x] #123`
    const re = new RegExp(`-\\s*\\[\\s*\\]\\s+#${subIssueId}\\b`, 'g');
    newBody = newBody.replace(re, `${targetBox} #${subIssueId}`);
  } else {
    // replace `- [x] #123` or `- [X] #123` with `- [ ] #123`
    const re = new RegExp(`-\\s*\\[[xX]\\]\\s+#${subIssueId}\\b`, 'g');
    newBody = newBody.replace(re, `${targetBox} #${subIssueId}`);
  }

  if (newBody !== body) {
    await provider.updateTicket(ticketId, {
      body: newBody,
    });
  }
}

/**
 * Post a structured comment to a ticket.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {'progress'|'friction'|'notification'} type
 * @param {string} payload
 */
export async function postStructuredComment(provider, ticketId, type, payload) {
  assertValidStructuredCommentType(type);
  await provider.postComment(ticketId, {
    type,
    body: payload,
  });
  // Story #2465 — evict the raw-comments cache entry so the next
  // `findStructuredComment` against this ticket re-fetches and sees the
  // freshly-posted comment.
  invalidateRawCommentsCache(provider, ticketId);
}

/**
 * Idempotently post a structured comment identified by an embedded HTML
 * marker. If an existing comment with the same `type` marker (and matching
 * `attrs`, when supplied) exists it is deleted first, then the new one is
 * posted. The marker is prepended to the body automatically.
 *
 * `attrs` lets the same `type` carry multiple in-place snapshots keyed by
 * an additional dimension — e.g., one `wave-run-progress` comment per wave
 * via `{ wave: N }` so the cross-wave rollup can read every wave's snapshot
 * instead of only the most recent one.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} type - arbitrary structured-comment type (e.g.,
 *   `dispatch-manifest`, `retro`, `code-review`).
 * @param {string} body - markdown payload.
 * @param {Record<string, string|number>} [attrs]
 * @returns {Promise<{ commentId: number }>}
 */
export async function upsertStructuredComment(
  provider,
  ticketId,
  type,
  body,
  attrs = null,
) {
  assertValidStructuredCommentType(type);
  const marker = structuredCommentMarker(type, attrs);
  const cacheKey = structuredCommentCacheKey(ticketId, type, attrs);
  const cache = getProviderCommentCache(provider);
  const existing = await findStructuredComment(provider, ticketId, type, attrs);

  if (existing && typeof provider.deleteComment === 'function') {
    try {
      await provider.deleteComment(existing.id);
      // Story #1795 — evict before the repost so a postComment failure
      // doesn't leave the cache pointing at a deleted comment id.
      cache.delete(cacheKey);
      // Story #2465 — the raw-comments array still holds the
      // just-deleted comment; drop it so subsequent reads re-fetch.
      invalidateRawCommentsCache(provider, ticketId);
    } catch (err) {
      Logger.warn(
        `[Ticketing] Failed to delete prior ${type} comment #${existing.id}: ${err.message}`,
      );
    }
  }

  const annotated = `${marker}\n\n${body}`;
  const result = await provider.postComment(ticketId, {
    type,
    body: annotated,
  });
  // Story #2465 — evict the raw-comments cache so a follow-up
  // `findStructuredComment` for a different type on the same ticket
  // re-fetches and observes the new comment.
  invalidateRawCommentsCache(provider, ticketId);
  // Story #1795 — refresh the cache to the freshly-posted comment so the
  // next upsert short-circuits the `getTicketComments` list call. The
  // post result carries the new comment id; we synthesise a minimal
  // cached row that `findStructuredComment` callers can rely on (only
  // `id` and `body` are read by upstream). Accept either `commentId`
  // (production GitHubProvider shape) or `id` (test-fake shape) so the
  // cache update fires uniformly across providers.
  const newCommentId =
    typeof result?.commentId === 'number'
      ? result.commentId
      : typeof result?.id === 'number'
        ? result.id
        : null;
  if (newCommentId !== null) {
    cache.set(cacheKey, {
      id: newCommentId,
      body: annotated,
    });
  }
  return result;
}
