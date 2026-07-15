import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleRemoteVerificationFailure } from '../../.agents/scripts/single-story-init.js';

describe('single-story-init remote verification', () => {
  it('blocks the Story and throws before delivery mutation', async () => {
    const updates = [];
    const comments = [];
    const provider = {
      async getTicketComments() {
        return [];
      },
      async postComment(storyId, payload) {
        comments.push({ storyId, body: payload.body });
        return { id: 1 };
      },
      async deleteComment() {},
      async updateTicket(storyId, payload) {
        updates.push({ storyId, payload });
      },
    };

    await assert.rejects(
      () =>
        handleRemoteVerificationFailure({
          provider,
          storyId: 42,
          remote: {
            remoteVerified: false,
            detail: 'origin is unreachable',
          },
        }),
      /remote verification failed/,
    );
    assert.deepEqual(updates[0], {
      storyId: 42,
      payload: {
        labels: {
          add: ['agent::blocked'],
          remove: ['agent::ready', 'agent::executing'],
        },
      },
    });
    assert.match(comments[0].body, /origin is unreachable/);
  });

  it('does not mutate or throw for a verified remote', async () => {
    await handleRemoteVerificationFailure({
      provider: null,
      storyId: 42,
      remote: { remoteVerified: true },
    });
  });
});
