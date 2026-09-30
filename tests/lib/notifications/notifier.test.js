import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { NOTIFICATIONS_DEFAULTS } from '../../../.agents/scripts/lib/config/github.js';
import {
  eventSeverity,
  renderTransitionMessage,
  resolveWebhookUrl,
  SEVERITY_RANK,
} from '../../../.agents/scripts/lib/notifications/notifier.js';
import { notify } from '../../../.agents/scripts/notify.js';

const ORIG_WEBHOOK_ENV = process.env.NOTIFICATION_WEBHOOK_URL;

before(() => {
  delete process.env.NOTIFICATION_WEBHOOK_URL;
});

after(() => {
  if (ORIG_WEBHOOK_ENV === undefined) {
    delete process.env.NOTIFICATION_WEBHOOK_URL;
  } else {
    process.env.NOTIFICATION_WEBHOOK_URL = ORIG_WEBHOOK_ENV;
  }
});

describe('SEVERITY_RANK', () => {
  it('orders low < medium < high', () => {
    assert.ok(SEVERITY_RANK.low < SEVERITY_RANK.medium);
    assert.ok(SEVERITY_RANK.medium < SEVERITY_RANK.high);
  });
});

describe('eventSeverity', () => {
  it('Story → agent::done is medium', () => {
    assert.equal(
      eventSeverity({
        kind: 'state-transition',
        ticket: { type: 'story' },
        toState: 'agent::done',
      }),
      'medium',
    );
  });

  it('Epic → agent::done is medium', () => {
    assert.equal(
      eventSeverity({
        kind: 'state-transition',
        ticket: { type: 'epic' },
        toState: 'agent::done',
      }),
      'medium',
    );
  });

  it('Story and Epic → agent::blocked are high', () => {
    for (const type of ['story', 'epic']) {
      assert.equal(
        eventSeverity({
          kind: 'state-transition',
          ticket: { type },
          toState: 'agent::blocked',
        }),
        'high',
      );
    }
  });

  it('Task → agent::blocked stays low', () => {
    assert.equal(
      eventSeverity({
        kind: 'state-transition',
        ticket: { type: 'task' },
        toState: 'agent::blocked',
      }),
      'low',
    );
  });

  it('Story → intermediate state is low', () => {
    assert.equal(
      eventSeverity({
        kind: 'state-transition',
        ticket: { type: 'story' },
        toState: 'agent::executing',
      }),
      'low',
    );
    assert.equal(
      eventSeverity({
        kind: 'state-transition',
        ticket: { type: 'story' },
        toState: 'agent::ready',
      }),
      'low',
    );
  });

  it('Task → agent::done is low (only Story/Epic done is escalated)', () => {
    assert.equal(
      eventSeverity({
        kind: 'state-transition',
        ticket: { type: 'task' },
        toState: 'agent::done',
      }),
      'low',
    );
  });

  it('non state-transition kinds are low', () => {
    assert.equal(
      eventSeverity({ kind: 'opened', ticket: { type: 'story' } }),
      'low',
    );
    assert.equal(eventSeverity(null), 'low');
    assert.equal(eventSeverity(undefined), 'low');
  });
});

describe('blocked transition under the default allowlists', () => {
  it('mentions the operator on the ticket and prefixes the webhook [Action Required]', async () => {
    const event = {
      kind: 'state-transition',
      ticket: { id: 42, type: 'story', title: 'Blocked Story' },
      fromState: 'agent::executing',
      toState: 'agent::blocked',
    };
    const comments = [];
    const posts = [];
    await notify(
      42,
      {
        severity: eventSeverity(event),
        message: renderTransitionMessage(event),
        event: 'state-transition',
        level: 'story',
      },
      {
        config: {
          github: {
            repo: 'widgets',
            operatorHandle: '@op',
            notifications: {
              mentionOperator: NOTIFICATIONS_DEFAULTS.mentionOperator,
              commentEvents: [...NOTIFICATIONS_DEFAULTS.commentEvents],
              webhookEvents: [...NOTIFICATIONS_DEFAULTS.webhookEvents],
            },
          },
        },
        provider: {
          async postComment(id, data) {
            comments.push({ id, data });
          },
        },
        webhookUrl: 'https://webhook.example/hook',
        fetchImpl: async (_url, options) => {
          posts.push(JSON.parse(options.body));
          return { ok: true };
        },
      },
    );
    assert.equal(comments.length, 1);
    assert.match(comments[0].data.body, /^@op story #42/);
    assert.equal(posts.length, 1);
    assert.match(posts[0].text, /^\[Action Required\] widgets#42: /);
    assert.equal(posts[0].severity, 'high');
  });
});

describe('renderTransitionMessage', () => {
  it('renders fromState → toState when both present', () => {
    const msg = renderTransitionMessage({
      kind: 'state-transition',
      ticket: { id: 357, type: 'story' },
      fromState: 'agent::ready',
      toState: 'agent::executing',
    });
    assert.match(msg, /story #357/);
    assert.match(msg, /agent::ready/);
    assert.match(msg, /agent::executing/);
  });

  it('renders → toState when fromState is missing', () => {
    const msg = renderTransitionMessage({
      kind: 'state-transition',
      ticket: { id: 1, type: 'epic' },
      toState: 'agent::done',
    });
    assert.match(msg, /epic #1/);
    assert.match(msg, /agent::done/);
  });

  it('appends a truncated title when present', () => {
    const longTitle = 'x'.repeat(120);
    const msg = renderTransitionMessage({
      kind: 'state-transition',
      ticket: { id: 5, type: 'story', title: longTitle },
      toState: 'agent::done',
    });
    assert.ok(msg.endsWith('xxxxxxxx'));
    // Title slice cap is 80 chars.
    assert.ok(msg.length <= `story #5 · → \`agent::done\` — `.length + 80);
  });
});

describe('resolveWebhookUrl priority', () => {
  const ORIG = process.env.NOTIFICATION_WEBHOOK_URL;

  function restoreEnv() {
    if (ORIG === undefined) {
      delete process.env.NOTIFICATION_WEBHOOK_URL;
    } else {
      process.env.NOTIFICATION_WEBHOOK_URL = ORIG;
    }
  }

  afterEach(restoreEnv);

  it('prefers env var over mcp.json', () => {
    process.env.NOTIFICATION_WEBHOOK_URL = 'https://env.example/hook';
    const url = resolveWebhookUrl();
    assert.equal(url, 'https://env.example/hook');
  });

  it('returns null when nothing is configured', () => {
    delete process.env.NOTIFICATION_WEBHOOK_URL;
    const url = resolveWebhookUrl({ cwd: '/nonexistent-path-for-test' });
    assert.equal(url, null);
  });
});
