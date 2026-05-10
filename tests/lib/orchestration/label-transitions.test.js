import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  toDone,
  toExecuting,
} from '../../../.agents/scripts/lib/orchestration/label-transitions.js';

function recordingProvider(existingLabels = []) {
  const updates = [];
  return {
    updates,
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
    },
    async getTicket(id) {
      return { id, labels: [...existingLabels], body: '', title: '' };
    },
    async listSubIssues() {
      return [];
    },
  };
}

describe('label-transitions', () => {
  it('toExecuting adds agent::executing and removes the other state labels', async () => {
    const provider = recordingProvider(['type::task', 'agent::ready']);
    await toExecuting(provider, 100);
    const { labels, state } = provider.updates[0].mutations;
    assert.ok(labels.add.includes('agent::executing'));
    assert.ok(labels.remove.includes('agent::ready'));
    assert.ok(labels.remove.includes('agent::done'));
    assert.equal(state, 'open');
  });

  it('toDone transitions each ticket in the array and closes them', async () => {
    const provider = recordingProvider(['type::task', 'agent::executing']);
    await toDone(provider, [1, 2, 3]);
    // Three parent updates (one per ticket). Cascade may issue additional
    // updates on their parents; assert on the first three which are the
    // direct transitions in order.
    assert.deepEqual(
      provider.updates.slice(0, 3).map((u) => u.id),
      [1, 2, 3],
    );
    for (const update of provider.updates.slice(0, 3)) {
      assert.ok(update.mutations.labels.add.includes('agent::done'));
      assert.equal(update.mutations.state, 'closed');
      assert.equal(update.mutations.state_reason, 'completed');
    }
  });

  it('toDone rejects non-array input', async () => {
    const provider = recordingProvider();
    await assert.rejects(
      () => toDone(provider, 42),
      /ticketIds must be an array/,
    );
  });

  it('toDone on an empty array is a no-op', async () => {
    const provider = recordingProvider();
    await toDone(provider, []);
    assert.equal(provider.updates.length, 0);
  });
});
