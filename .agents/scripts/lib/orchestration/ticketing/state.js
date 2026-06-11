/**
 * lib/orchestration/ticketing/state.js — Ticket state-mutation facade.
 *
 * Owns the structured-comment upsert (`upsertStructuredComment`) and the
 * Storyless direct transition (`transitionStoryDirect`), and re-exports
 * the single-ticket mutators that now live in `./transition.js`
 * (`transitionTicketState`, `toggleTasklistCheckbox`,
 * `postStructuredComment`, `_resetColumnSyncCache`). Pulled out of
 * `../ticketing.js` under Story #1848 so the read-side (`./reads.js`) and
 * the cascade/bulk side (`./bulk.js`) each live behind a narrower import
 * contract.
 *
 * Story #3995 — the single-ticket mutators were extracted into the leaf
 * `./transition.js` to break the `state.js ↔ bulk.js` import cycle.
 * `bulk.js`'s cascade walk depends on those primitives, and the primitives
 * fire the upward cascade; lifting them into a leaf lets `state.js` and
 * `bulk.js` both depend **downward** on `transition.js`. This module is
 * the wiring point that injects `bulk.js`'s cascade pair
 * (`cascadeParentState` / `logCascadePartialFailures`) into
 * `transition.js` via `registerCascadeRunner`, so importing `state.js`
 * (or the `../ticketing.js` facade that re-exports through it) always
 * loads `bulk.js` and arms the real cascade before any transition runs.
 */

import { Logger } from '../../Logger.js';
import { cascadeParentState, logCascadePartialFailures } from './bulk.js';
import {
  assertValidStructuredCommentType,
  findStructuredComment,
  getProviderCommentCache,
  invalidateRawCommentsCache,
  structuredCommentCacheKey,
  structuredCommentMarker,
} from './reads.js';
import {
  _resetColumnSyncCache,
  postStructuredComment,
  registerCascadeRunner,
  toggleTasklistCheckbox,
  transitionTicketState,
} from './transition.js';

// Re-export the single-ticket mutators that moved to `./transition.js`
// (Story #3995) so existing consumers that import them from `./state.js`
// — and the `../ticketing.js` facade — keep working without an import
// path change.
export {
  _resetColumnSyncCache,
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
};

// Story #3995 — inject `bulk.js`'s upward-cascade pair into
// `transition.js`. `transition.js` stays a leaf (it does not import
// `bulk.js`); this wiring runs once at module-evaluation time and is the
// single home for the legacy `transitionTicketState → cascadeParentState`
// behaviour, preserving the `cascade` flag and the partial-failure log.
registerCascadeRunner(async (provider, ticketId, opts) => {
  const cascade = await cascadeParentState(provider, ticketId, {
    notify: opts.notify,
  });
  logCascadePartialFailures(ticketId, cascade);
});

/**
 * Transition a Story ticket directly to a new `agent::*` state without
 * walking a Task cascade. Story #3097 (Wave-0 additive, Epic #3078
 * Strategy B) — in the 2-tier hierarchy a Story has no Task children, so
 * the canonical `transitionTicketState` upward-cascade path
 * (`cascadeParentState`) is the only meaningful walk. This helper is a
 * thin wrapper that pins `cascade: true` (so the parent Epic
 * still receives derived-state updates) and is intentionally a no-op
 * difference from `transitionTicketState` in 4-tier mode — the helper
 * exists so 2-tier callers can opt into a name that documents intent
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
