import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlockerHandler } from '../../.agents/scripts/lib/orchestration/epic-runner/blocker-handler.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function recordingProvider() {
  const updates = [];
  const comments = [];
  return {
    updates,
    comments,
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
    },
    async postComment(id, payload) {
      comments.push({ id, payload });
    },
    async getTicket() {
      return { labels: [] };
    },
  };
}

describe('BlockerHandler', () => {
  it('halts and resumes when the epic transitions back to executing', async () => {
    const provider = recordingProvider();

    // Deterministic label transition: first two polls see blocked, then
    // the operator flips it back to executing. No wall-clock sleep needed
    // — halt() resolves on the poll that observes the flipped label.
    let pollCount = 0;
    const labelFetcher = async () => {
      pollCount += 1;
      if (pollCount <= 2) return ['type::epic', 'agent::blocked'];
      return ['type::epic', 'agent::executing'];
    };

    const notifyCalls = [];
    const notify = async (ticketId, payload, opts) => {
      notifyCalls.push({ ticketId, payload, opts });
    };
    const handler = new BlockerHandler({
      provider,
      epicId: 321,
      notify,
      labelFetcher,
      pollIntervalMs: 1,
      logger: quietLogger(),
    });

    const result = await handler.halt({
      reason: 'merge_conflict',
      storyId: 400,
    });
    assert.equal(result.resumed, true);
    assert.ok(pollCount >= 3, `expected ≥ 3 polls, got ${pollCount}`);

    // Marked blocked: add agent::blocked, remove agent::executing.
    const update = provider.updates[0];
    assert.ok(update.mutations.labels.add.includes('agent::blocked'));
    assert.ok(update.mutations.labels.remove.includes('agent::executing'));

    // Posted friction comment mentioning the story id.
    const comment = provider.comments[0];
    assert.equal(comment.payload.type, 'friction');
    assert.match(comment.payload.body, /Story: #400/);

    // Dispatched notify exactly once with high severity + epic-blocked
    // event + skipComment (the friction comment was already posted above).
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].ticketId, 321);
    assert.equal(notifyCalls[0].payload.severity, 'high');
    assert.equal(notifyCalls[0].payload.event, 'epic-blocked');
    assert.equal(notifyCalls[0].payload.level, 'epic');
    assert.equal(notifyCalls[0].payload.epicId, 321);
    assert.match(notifyCalls[0].payload.message, /Epic #321/);
    assert.match(notifyCalls[0].payload.message, /story #400/);
    assert.equal(notifyCalls[0].opts?.skipComment, true);
  });

  it('notify dispatch failures do not bubble out of halt()', async () => {
    const provider = recordingProvider();
    const handler = new BlockerHandler({
      provider,
      epicId: 321,
      notify: async () => {
        throw new Error('notify-boom');
      },
      labelFetcher: async () => ['type::epic', 'agent::executing'],
      pollIntervalMs: 1,
      logger: quietLogger(),
    });
    // Notify failure must be swallowed; halt() still resumes on the first
    // poll (labelFetcher returns executing from the start).
    const result = await handler.halt({ reason: 'x' });
    assert.equal(result.resumed, true);
  });

  it('honors the abort signal while waiting', async () => {
    const provider = recordingProvider();
    const controller = new AbortController();

    // Abort as soon as the poll loop makes its second call — a deterministic
    // signal that halt() is really waiting, with no wall-clock race.
    let pollCount = 0;
    const labelFetcher = async () => {
      pollCount += 1;
      if (pollCount === 2) controller.abort();
      return ['type::epic', 'agent::blocked'];
    };
    const handler = new BlockerHandler({
      provider,
      epicId: 321,
      notify: async () => {},
      labelFetcher,
      pollIntervalMs: 1,
      logger: quietLogger(),
    });
    const res = await handler.halt({ reason: 'stuck' }, controller.signal);
    assert.equal(res.resumed, false);
    assert.equal(res.reasonToStop, 'aborted');
  });
});
