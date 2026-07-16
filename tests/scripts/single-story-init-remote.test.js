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
    // Story #4539 — this flip goes through the canonical
    // `transitionTicketState` mutator rather than a direct label write, so
    // the Projects v2 column follows the Story off `agent::ready`. Assert
    // the transition's meaning (blocked, every other state cleared) rather
    // than the mutator's exact payload shape, which is its own contract.
    assert.equal(updates.length, 1);
    assert.equal(updates[0].storyId, 42);
    const { labels } = updates[0].payload;
    assert.deepEqual(labels.add, ['agent::blocked']);
    for (const cleared of [
      'agent::ready',
      'agent::executing',
      'agent::closing',
      'agent::done',
    ]) {
      assert.ok(
        labels.remove.includes(cleared),
        `the transition clears ${cleared}`,
      );
    }
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
