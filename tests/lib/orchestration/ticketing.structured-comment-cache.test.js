/**
 * Story #1795 — Process-level structured-comment ID cache contract tests.
 *
 * `findStructuredComment` / `upsertStructuredComment` memoise their
 * resolved (ticketId, type, attrs) row in a process-level cache so
 * repeat upserts on the hot path skip the `getTicketComments` list
 * call. The cache invalidates on delete and refreshes on post.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  _resetStructuredCommentCache,
  findStructuredComment,
  structuredCommentMarker,
  upsertStructuredComment,
} from '../../../.agents/scripts/lib/orchestration/ticketing.js';

function makeProvider({ existingComments = [] } = {}) {
  let nextId = 1000;
  const getCommentsCalls = [];
  const deleteCalls = [];
  const postCalls = [];
  const comments = [...existingComments];
  return {
    getCommentsCalls,
    deleteCalls,
    postCalls,
    async getTicketComments(id) {
      getCommentsCalls.push(id);
      return comments.slice();
    },
    async deleteComment(id) {
      deleteCalls.push(id);
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
    async postComment(_ticketId, payload) {
      postCalls.push(payload);
      const id = nextId++;
      comments.push({ id, body: payload.body });
      return { commentId: id };
    },
  };
}

describe('structured-comment ID cache (Story #1795)', () => {
  beforeEach(() => {
    _resetStructuredCommentCache();
  });

  it('first upsert hits getTicketComments; second upsert skips it', async () => {
    const provider = makeProvider();
    await upsertStructuredComment(provider, 1795, 'story-init', 'body-A');
    assert.equal(provider.getCommentsCalls.length, 1);
    await upsertStructuredComment(provider, 1795, 'story-init', 'body-B');
    assert.equal(
      provider.getCommentsCalls.length,
      1,
      'second upsert must serve the existing-comment lookup from cache',
    );
    // Two posts (first creates, second deletes + reposts).
    assert.equal(provider.postCalls.length, 2);
  });

  it('first upsert finds an existing comment via getTicketComments (legacy seed path)', async () => {
    const marker = structuredCommentMarker('story-init');
    const provider = makeProvider({
      existingComments: [{ id: 42, body: `${marker}\n\nold body` }],
    });
    await upsertStructuredComment(provider, 1795, 'story-init', 'new body');
    // The first call DID hit getTicketComments — it had to discover the
    // pre-existing comment.
    assert.equal(provider.getCommentsCalls.length, 1);
    // Delete fired against the discovered id.
    assert.deepEqual(provider.deleteCalls, [42]);
    // Repost happened.
    assert.equal(provider.postCalls.length, 1);
  });

  it('delete-then-repost sequence updates the cached id to the new comment id', async () => {
    const provider = makeProvider();
    await upsertStructuredComment(provider, 1795, 'story-init', 'v1');
    const firstId = provider.postCalls.length;
    await upsertStructuredComment(provider, 1795, 'story-init', 'v2');
    // After the second upsert: the cache row must point at the v2 comment.
    // We can probe by issuing a findStructuredComment — if the cache lost
    // sync the provider would receive another getTicketComments call.
    const before = provider.getCommentsCalls.length;
    const row = await findStructuredComment(provider, 1795, 'story-init');
    assert.equal(provider.getCommentsCalls.length, before);
    assert.ok(row, 'findStructuredComment should return the cached row');
    assert.ok(row.body.includes('v2'), 'cached row should reflect v2 body');
    assert.notEqual(firstId, row.id);
  });

  it('distinct attrs do not share a cache slot (per-wave wave-N-end use case)', async () => {
    const provider = makeProvider();
    await upsertStructuredComment(provider, 1, 'progress', 'wave-1 body', {
      wave: 1,
    });
    await upsertStructuredComment(provider, 1, 'progress', 'wave-2 body', {
      wave: 2,
    });
    // Each distinct (wave) attr cold-starts its own cache slot, so both
    // need their own getTicketComments seed call. The post fires twice.
    assert.equal(provider.getCommentsCalls.length, 2);
    assert.equal(provider.postCalls.length, 2);
  });
});
