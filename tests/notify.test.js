import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { notify, parseNotifyArgs } from '../.agents/scripts/notify.js';

const DEFAULT_WEBHOOK = 'https://webhook.example.com/action';

// Permissive allowlists for the test mock — covers the curated production
// vocabularies plus the legacy story/task event names tests still exercise
// to prove envelope shape and routing semantics. Production `.agentrc.json`
// ships narrower allowlists; tests deliberately broaden them so each case
// can choose whether the dispatch carries an allowlisted event for the
// channel under test.
const DEFAULT_WEBHOOK_EVENTS = [
  'epic-started',
  'epic-progress',
  'epic-blocked',
  'epic-unblocked',
  'epic-complete',
  'story-merged',
  'story-run-progress',
  'state-transition',
  'task-transition',
];
const DEFAULT_COMMENT_EVENTS = [
  'state-transition',
  'task-transition',
  'story-merged',
  'story-run-progress',
  'operator-message',
  'epic-blocked',
  'epic-complete',
];

describe('notify script', () => {
  let mockProvider;
  let mockConfig;
  let fetchCalls;
  let defaultOpts;

  beforeEach(() => {
    fetchCalls = [];

    // Injected fake fetch (threaded via opts.fetchImpl) — no global
    // monkeypatch. Records each call so tests can assert the POST body and
    // headers; URLs containing `fail` reject to exercise the catch branch.
    const fakeFetch = async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.includes('fail')) {
        throw new Error('Network error');
      }
      return { ok: true };
    };

    mockProvider = {
      comments: [],
      async postComment(ticketId, data) {
        this.comments.push({ ticketId, data });
      },
    };

    mockConfig = {
      github: {
        owner: 'acme',
        repo: 'widgets',
        operatorHandle: '@test_operator',
        notifications: {
          mentionOperator: true,
          commentEvents: [...DEFAULT_COMMENT_EVENTS],
          webhookEvents: [...DEFAULT_WEBHOOK_EVENTS],
        },
      },
    };

    defaultOpts = {
      provider: mockProvider,
      config: mockConfig,
      webhookUrl: DEFAULT_WEBHOOK,
      fetchImpl: fakeFetch,
    };
  });

  it('medium with mentionOperator=true posts mentioned comment + fires allowlisted webhook with typed envelope', async () => {
    await notify(
      123,
      {
        severity: 'medium',
        message: 'Story merged.',
        event: 'story-merged',
        level: 'story',
        epicId: 456,
      },
      defaultOpts,
    );

    assert.equal(mockProvider.comments.length, 1);
    const comment = mockProvider.comments[0];
    assert.equal(comment.ticketId, 123);
    assert.equal(comment.data.body, '@test_operator Story merged.');
    assert.equal(comment.data.type, 'notification');

    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.text, '[medium] widgets#123: Story merged.');
    assert.equal(body.severity, 'medium');
    assert.equal(body.ticketId, 123);
    assert.equal(body.event, 'story-merged');
    assert.equal(body.level, 'story');
    assert.equal(body.epicId, 456);
  });

  it('typed envelope carries event/level/epicId/phase when provided', async () => {
    await notify(
      1234,
      {
        severity: 'low',
        message: 'Story #1234 · implementing · 3/6 tasks done',
        event: 'story-run-progress',
        level: 'story',
        epicId: 946,
        phase: 'implementing',
      },
      { ...defaultOpts, skipComment: true },
    );

    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.severity, 'low');
    assert.equal(body.event, 'story-run-progress');
    assert.equal(body.level, 'story');
    assert.equal(body.epicId, 946);
    assert.equal(body.phase, 'implementing');
    assert.equal(body.ticketId, 1234);
    assert.match(body.text, /\[low\] widgets#1234:/);
  });

  it('high always @mentions and fires [Action Required] webhook when event is allowlisted', async () => {
    mockConfig.github.notifications.mentionOperator = false;

    await notify(
      124,
      {
        severity: 'high',
        message: '🚨 Action Required: Approve deploy?',
        event: 'epic-blocked',
        level: 'epic',
        epicId: 124,
      },
      defaultOpts,
    );

    assert.equal(mockProvider.comments.length, 1);
    assert.equal(
      mockProvider.comments[0].data.body,
      '@test_operator 🚨 Action Required: Approve deploy?',
    );
    assert.equal(mockProvider.comments[0].data.type, 'friction');

    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(
      body.text,
      '[Action Required] widgets#124: 🚨 Action Required: Approve deploy?',
    );
    assert.equal(body.severity, 'high');
  });

  it('dispatches without an event field never reach the comment OR webhook channel', async () => {
    // Both channels are gated by event-name allowlist. An untyped
    // `notify()` call carries no routing key and is dropped from both
    // channels regardless of severity.
    await notify(
      125,
      { severity: 'high', message: 'Untyped milestone.' },
      defaultOpts,
    );

    assert.equal(
      mockProvider.comments.length,
      0,
      'untyped dispatch never reaches the comment channel',
    );
    assert.equal(
      fetchCalls.length,
      0,
      'untyped dispatch never reaches the webhook channel',
    );
  });

  it('dispatches with an event NOT on the webhook allowlist are dropped from the webhook', async () => {
    mockConfig.github.notifications.webhookEvents = ['epic-blocked'];

    await notify(
      201,
      {
        severity: 'medium',
        message: 'Story merged.',
        event: 'story-merged',
        level: 'story',
      },
      defaultOpts,
    );

    assert.equal(
      mockProvider.comments.length,
      1,
      'comment still posts — story-merged is on the comment allowlist',
    );
    assert.equal(
      fetchCalls.length,
      0,
      'story-merged not on webhook allowlist — webhook suppressed',
    );
  });

  it('dispatches with an event NOT on the comment allowlist are dropped from the comment channel', async () => {
    mockConfig.github.notifications.commentEvents = ['operator-message'];

    await notify(
      202,
      {
        severity: 'medium',
        message: 'Story merged.',
        event: 'story-merged',
        level: 'story',
      },
      defaultOpts,
    );

    assert.equal(
      mockProvider.comments.length,
      0,
      'story-merged not on comment allowlist — comment suppressed',
    );
    assert.equal(
      fetchCalls.length,
      1,
      'webhook still fires — story-merged is on the webhook allowlist',
    );
  });

  it('empty webhookEvents allowlist suppresses every webhook', async () => {
    mockConfig.github.notifications.webhookEvents = [];

    await notify(
      202,
      {
        severity: 'high',
        message: '🚨 Action Required: Approve deploy?',
        event: 'epic-blocked',
      },
      defaultOpts,
    );

    assert.equal(
      fetchCalls.length,
      0,
      'empty allowlist suppresses the webhook even for high-severity allowlisted-name events',
    );
  });

  it('empty commentEvents allowlist suppresses every comment', async () => {
    mockConfig.github.notifications.commentEvents = [];

    await notify(
      203,
      {
        severity: 'high',
        message: '🚨 Action Required: Approve deploy?',
        event: 'epic-blocked',
      },
      defaultOpts,
    );

    assert.equal(
      mockProvider.comments.length,
      0,
      'empty allowlist suppresses the comment even for high-severity allowlisted-name events',
    );
  });

  it('severity is carried as envelope metadata regardless of allowlist routing', async () => {
    mockConfig.github.notifications.webhookEvents = ['epic-progress'];

    await notify(
      300,
      {
        severity: 'low',
        message: 'Epic #300 progress · 1/5 stories done',
        event: 'epic-progress',
        level: 'epic',
        epicId: 300,
      },
      { ...defaultOpts, skipComment: true },
    );

    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.severity, 'low');
    assert.equal(body.event, 'epic-progress');
  });

  it('skipComment opt suppresses comment but webhook still fires when event is allowlisted', async () => {
    await notify(
      210,
      {
        severity: 'low',
        message: 'task #N → executing',
        event: 'task-transition',
      },
      { ...defaultOpts, skipComment: true },
    );

    assert.equal(mockProvider.comments.length, 0);
    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.text, '[low] widgets#210: task #N → executing');
  });

  it('rejects an invalid severity', async () => {
    await assert.rejects(
      () => notify(1, { severity: 'urgent', message: 'x' }, defaultOpts),
      /Invalid severity/,
    );
  });

  it('tolerates webhook failures silently', async () => {
    await notify(
      125,
      {
        severity: 'high',
        message: 'Review needed.',
        event: 'epic-blocked',
      },
      {
        ...defaultOpts,
        webhookUrl: 'https://webhook.example.com/fail',
      },
    );

    assert.equal(mockProvider.comments.length, 1);
    assert.equal(fetchCalls.length, 1);
  });

  it('skips webhook if url is not configured', async () => {
    await notify(
      126,
      {
        severity: 'high',
        message: 'Review needed.',
        event: 'epic-blocked',
      },
      {
        provider: mockProvider,
        config: mockConfig,
        webhookUrl: null,
      },
    );

    assert.equal(mockProvider.comments.length, 1);
    assert.equal(fetchCalls.length, 0);
  });

  it('emits a Logger.warn when an allowlisted event is suppressed by a missing webhook URL', async () => {
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (msg) => {
      warnCalls.push(String(msg));
    };
    try {
      await notify(
        126,
        {
          severity: 'high',
          message: 'Review needed.',
          event: 'epic-blocked',
        },
        {
          provider: mockProvider,
          config: mockConfig,
          webhookUrl: null,
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    const suppressionWarn = warnCalls.find((m) =>
      m.includes('Webhook event (epic-blocked) suppressed'),
    );
    assert.ok(
      suppressionWarn,
      `expected a suppression warn line, got: ${JSON.stringify(warnCalls)}`,
    );
    assert.match(suppressionWarn, /NOTIFICATION_WEBHOOK_URL/);
  });

  it('skips GitHub comment if ticketId is 0 or missing', async () => {
    await notify(
      0,
      {
        severity: 'medium',
        message: 'Sidecar message',
        event: 'epic-progress',
      },
      defaultOpts,
    );

    assert.equal(mockProvider.comments.length, 0);
  });

  it('does not @mention on medium when mentionOperator is false', async () => {
    mockConfig.github.notifications.mentionOperator = false;

    await notify(
      127,
      {
        severity: 'medium',
        message: 'Story merged.',
        event: 'story-merged',
      },
      defaultOpts,
    );

    assert.equal(mockProvider.comments.length, 1);
    assert.equal(mockProvider.comments[0].data.body, 'Story merged.');
  });

  it('includes X-Signature-256 header when WEBHOOK_SECRET is provided', async () => {
    const originalSecret = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = 'shhh-secret';

    try {
      await notify(
        128,
        {
          severity: 'high',
          message: 'Secret action',
          event: 'epic-blocked',
        },
        defaultOpts,
      );

      assert.equal(fetchCalls.length, 1);
      const headers = fetchCalls[0].options.headers;
      assert.ok(headers['X-Signature-256']);
      assert.ok(headers['X-Signature-256'].startsWith('sha256='));
    } finally {
      process.env.WEBHOOK_SECRET = originalSecret;
    }
  });

  it('injects a fake fetch and asserts POST body, X-Signature-256 header, and 4xx/5xx branches', async () => {
    const originalSecret = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = 'inject-secret';

    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (msg) => {
      warnCalls.push(String(msg));
    };

    try {
      // Arrange: a fake fetch local to this test, returning a not-ok
      // response with a configurable status to drive the 4xx/5xx branch.
      const calls = [];
      let nextResponse = { ok: true };
      const fakeFetch = async (url, options) => {
        calls.push({ url, options });
        return nextResponse;
      };

      const opts = { ...defaultOpts, fetchImpl: fakeFetch };

      // Act 1 — happy path: assert the injected fetch saw a POST with the
      // signed envelope body and the HMAC signature header.
      await notify(
        500,
        {
          severity: 'high',
          message: 'Injected dispatch',
          event: 'epic-blocked',
          level: 'epic',
          epicId: 500,
        },
        opts,
      );

      assert.equal(calls.length, 1, 'injected fetch is invoked exactly once');
      assert.equal(calls[0].url, DEFAULT_WEBHOOK);
      assert.equal(calls[0].options.method, 'POST');
      assert.equal(
        calls[0].options.headers['Content-Type'],
        'application/json',
      );
      const sig = calls[0].options.headers['X-Signature-256'];
      assert.ok(sig?.startsWith('sha256='), 'X-Signature-256 is present');

      const body = JSON.parse(calls[0].options.body);
      assert.equal(
        body.text,
        '[Action Required] widgets#500: Injected dispatch',
      );
      assert.equal(body.severity, 'high');
      assert.equal(body.event, 'epic-blocked');
      assert.equal(body.epicId, 500);

      // The signature is the HMAC-SHA256 of the exact serialized body.
      const { createHmac } = await import('node:crypto');
      const expectedSig = createHmac('sha256', 'inject-secret')
        .update(calls[0].options.body)
        .digest('hex');
      assert.equal(sig, `sha256=${expectedSig}`);

      // Act 2 — 4xx branch: a not-ok response warns instead of throwing.
      nextResponse = {
        ok: false,
        status: 404,
        text: async () => 'not found',
      };
      await notify(
        501,
        { severity: 'high', message: '4xx', event: 'epic-blocked' },
        opts,
      );
      assert.ok(
        warnCalls.some((m) => m.includes('Webhook returned 404')),
        '4xx response surfaces a Logger.warn',
      );

      // Act 3 — 5xx branch: same non-throwing warn path.
      nextResponse = {
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      };
      await notify(
        502,
        { severity: 'high', message: '5xx', event: 'epic-blocked' },
        opts,
      );
      assert.ok(
        warnCalls.some((m) => m.includes('Webhook returned 503')),
        '5xx response surfaces a Logger.warn',
      );
    } finally {
      console.warn = originalWarn;
      process.env.WEBHOOK_SECRET = originalSecret;
    }
  });

  it('defaults severity to medium when omitted; webhook still requires an allowlisted event', async () => {
    await notify(
      129,
      { message: 'Default sev.', event: 'epic-complete' },
      defaultOpts,
    );

    assert.equal(fetchCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.text, '[medium] widgets#129: Default sev.');
    assert.equal(body.severity, 'medium');
    assert.equal(body.event, 'epic-complete');
  });
});

describe('parseNotifyArgs', () => {
  it('parses explicit --ticket flag with default severity', () => {
    const parsed = parseNotifyArgs(['--ticket', '321', 'Epic closed.']);
    assert.deepEqual(parsed, {
      ticketId: 321,
      message: 'Epic closed.',
      severity: 'medium',
    });
  });

  it('parses --severity high', () => {
    const parsed = parseNotifyArgs([
      '--ticket',
      '321',
      'Approve deploy.',
      '--severity',
      'high',
    ]);
    assert.deepEqual(parsed, {
      ticketId: 321,
      message: 'Approve deploy.',
      severity: 'high',
    });
  });

  it('parses legacy numeric ticket id followed by multi-word message', () => {
    const parsed = parseNotifyArgs([
      '321',
      'Planning complete.',
      'Review now.',
    ]);
    assert.deepEqual(parsed, {
      ticketId: 321,
      message: 'Planning complete. Review now.',
      severity: 'medium',
    });
  });
});
