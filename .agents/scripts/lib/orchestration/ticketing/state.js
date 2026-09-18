/**
 * lib/orchestration/ticketing/state.js — Ticket state-mutation facade:
 * structured-comment upsert, the direct Story transition, and re-exports of
 * `./transition.js`. Importing this module wires `bulk.js`'s cascade into
 * `transition.js`, so the real cascade is armed before any transition runs.
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

export {
  _resetColumnSyncCache,
  postStructuredComment,
  toggleTasklistCheckbox,
  transitionTicketState,
};

registerCascadeRunner(async (provider, ticketId, opts) => {
  const cascade = await cascadeParentState(provider, ticketId, {
    notify: opts.notify,
  });
  logCascadePartialFailures(ticketId, cascade);
});

/**
 * `transitionTicketState` with `cascade` defaulting to `true`, so the parent
 * Epic still receives derived-state updates; every other opt passes through.
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
 * Idempotently post a marker-identified structured comment: delete any
 * existing one with the same `type` (and `attrs`), then post with the marker
 * prepended. `attrs` keeps several snapshots of one type side by side.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} type - a registered structured-comment type.
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
      // Evict before the repost so a failed post can't leave the caches
      // pointing at a deleted comment.
      cache.delete(cacheKey);
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
  invalidateRawCommentsCache(provider, ticketId);
  // Seed the cache with a minimal `{ id, body }` row so the next upsert
  // skips the list call. Providers return `commentId` (GitHub) or `id` (fakes).
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
