import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postBatchedTransitionSummary } from '../../../.agents/scripts/lib/story-init/transition-summary.js';

describe('postBatchedTransitionSummary', () => {
  it('posts ONE notification listing every transitioned Task ID', async () => {
    const calls = [];
    const notify = (ticketId, payload) => {
      calls.push({ ticketId, payload });
    };

    const out = await postBatchedTransitionSummary({
      notify,
      storyId: 701,
      transitioned: [802, 801, 803],
    });

    assert.equal(calls.length, 1, 'exactly one summary notification fires');
    assert.equal(calls[0].ticketId, 701);
    assert.equal(calls[0].payload.severity, 'low');
    assert.match(calls[0].payload.message, /Story #701/);
    assert.match(calls[0].payload.message, /3 Task\(s\)/);
    assert.match(calls[0].payload.message, /#802, #801, #803/);
    assert.equal(out.posted, true);
    assert.equal(out.message, calls[0].payload.message);
  });

  it('skips when no Tasks transitioned', async () => {
    const calls = [];
    const notify = (...args) => calls.push(args);

    const out = await postBatchedTransitionSummary({
      notify,
      storyId: 701,
      transitioned: [],
    });

    assert.equal(calls.length, 0);
    assert.equal(out.posted, false);
  });

  it('skips when notify is null', async () => {
    const out = await postBatchedTransitionSummary({
      notify: null,
      storyId: 701,
      transitioned: [802, 801],
    });
    assert.equal(out.posted, false);
  });

  it('integrates with notify(): exactly ONE provider.postComment when commentMinLevel=low', async () => {
    const { notify } = await import('../../../.agents/scripts/notify.js');

    const provider = {
      comments: [],
      async postComment(ticketId, data) {
        this.comments.push({ ticketId, data });
      },
    };
    const orchestration = {
      github: { owner: 'acme', repo: 'widgets', operatorHandle: '@op' },
      notifications: {
        commentMinLevel: 'low',
        webhookMinLevel: 'high',
        terminalMinLevel: 'medium',
      },
    };
    // Stub fetch defensively per the documented webhook-leak pattern. Even
    // though webhookMinLevel=high suppresses the webhook, leaving fetch
    // unstubbed would attempt a real network call if the filter ever
    // regresses.
    const fetchCalls = [];
    const fetchImpl = async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true };
    };
    const originalFetch = global.fetch;
    global.fetch = fetchImpl;

    try {
      const wrappedNotify = (ticketId, payload) =>
        notify(ticketId, payload, {
          provider,
          orchestration,
          webhookUrl: null,
        });

      await postBatchedTransitionSummary({
        notify: wrappedNotify,
        storyId: 701,
        transitioned: [802, 801],
      });

      assert.equal(provider.comments.length, 1, 'exactly one comment posted');
      assert.equal(provider.comments[0].ticketId, 701);
      assert.match(provider.comments[0].data.body, /#802, #801/);
      assert.equal(
        fetchCalls.length,
        0,
        'webhook suppressed by webhookMinLevel=high',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
