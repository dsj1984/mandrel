import assert from 'node:assert';
import { test } from 'node:test';
import { STATE_LABELS } from '../../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  transitionStoryToExecuting,
  transitionTaskStates,
} from '../../../.agents/scripts/lib/story-init/state-transitioner.js';

function mkProvider({ updateTicket, getTicket }) {
  return {
    async updateTicket(id, patch) {
      if (updateTicket) return updateTicket(id, patch);
    },
    async getTicket(id) {
      if (getTicket) return getTicket(id);
      return { id, labels: [], title: `t${id}` };
    },
  };
}

test('transitionStoryToExecuting flips the Story to agent::executing', async () => {
  const calls = [];
  const provider = mkProvider({
    updateTicket: (id, patch) => {
      calls.push({ id, patch });
    },
  });
  const story = { id: 100, title: 'Story', labels: ['type::story'] };
  const out = await transitionStoryToExecuting({
    provider,
    input: { storyId: 100, story },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].id, 100);
  assert.ok(calls[0].patch.labels.add.includes(STATE_LABELS.EXECUTING));
});

test('returns ok:true when every task transitions successfully', async () => {
  const calls = [];
  const provider = mkProvider({
    updateTicket: (id, patch) => {
      calls.push({ id, patch });
    },
  });
  const out = await transitionTaskStates({
    provider,
    input: {
      tasks: [
        { id: 1, title: 't1', labels: ['type::task'] },
        { id: 2, title: 't2', labels: ['type::task'] },
      ],
    },
  });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.failed, []);
  assert.strictEqual(calls.length, 2);
  assert.ok(
    calls.every((c) => c.patch.labels.add.includes('agent::executing')),
  );
});

test('collects failed transitions in the failed array', async () => {
  const provider = mkProvider({
    updateTicket: (id) => {
      if (id === 2) throw new Error('boom');
    },
  });
  const out = await transitionTaskStates({
    provider,
    input: {
      tasks: [
        { id: 1, title: 't1', labels: ['type::task'] },
        { id: 2, title: 't2', labels: ['type::task'] },
      ],
    },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.failed.length, 1);
  assert.strictEqual(out.failed[0].id, 2);
});

test('skips tasks already labelled agent::executing', async () => {
  const calls = [];
  const provider = mkProvider({
    updateTicket: (id, patch) => calls.push({ id, patch }),
  });
  const out = await transitionTaskStates({
    provider,
    input: {
      tasks: [
        { id: 1, title: 't1', labels: ['type::task', 'agent::executing'] },
      ],
    },
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.length, 0);
});
