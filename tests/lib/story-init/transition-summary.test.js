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

  it('integrates with notify(): summary is a no-op without an event under curated allowlists', async () => {
    // The summary helper dispatches an event-less notify() call. Under the
    // post-#1276 event-allowlist model both channels gate on event-name
    // membership, so an event-less dispatch is a deliberate no-op — even
    // when the operator's allowlists are permissive. This preserves the
    // silent-init behavior the previous severity-`low` filtering produced.
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
        // Permissive allowlists — proves the no-op is the design, not the
        // operator's filtering.
        commentEvents: ['state-transition', 'story-merged', 'operator-message'],
        webhookEvents: [],
      },
    };
    // Stub fetch defensively per the documented webhook-leak pattern.
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

      assert.equal(
        provider.comments.length,
        0,
        'event-less summary is dropped by the comment-event allowlist',
      );
      assert.equal(
        fetchCalls.length,
        0,
        'event-less summary is dropped by the webhook-event allowlist',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
