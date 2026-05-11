import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import {
  eventSeverity,
  renderTransitionMessage,
  resolveWebhookUrl,
  SEVERITY_RANK,
} from '../../../.agents/scripts/lib/notifications/notifier.js';

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
