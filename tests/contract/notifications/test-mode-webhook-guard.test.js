// tests/contract/notifications/test-mode-webhook-guard.test.js
/**
 * Story #2975 — guarantee that tests do NOT POST to the operator's real
 * Slack webhook even when `.env` sets `NOTIFICATION_WEBHOOK_URL`.
 *
 * Two defenses cover the surface:
 *
 *   1. `run-tests.js` scrubs `NOTIFICATION_WEBHOOK_URL` from the test
 *      child env and sets `NODE_ENV=test`. Tests inherit a clean env.
 *   2. `notify.js` refuses to resolve the env URL when `NODE_ENV=test`
 *      unless the caller explicitly passed `opts.webhookUrl` (opt-in)
 *      or `MANDREL_ALLOW_TEST_WEBHOOKS=1` is set.
 *
 * This contract test exercises defense #2 directly: it sets a sentinel
 * URL on `process.env.NOTIFICATION_WEBHOOK_URL` (simulating a test
 * surface that bypassed the runner-level scrub — e.g. `node --test`
 * invoked directly), dispatches an allowlisted webhook event with NO
 * `opts.webhookUrl`, and asserts the global `fetch` is never called.
 *
 * Includes the inverse case: with `MANDREL_ALLOW_TEST_WEBHOOKS=1` the
 * guard yields and the dispatch reaches the (stubbed) fetch.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { notify } from '../../../.agents/scripts/notify.js';

const SENTINEL_URL = 'https://should-never-fire.invalid/hook';

function makeConfig() {
  return {
    github: {
      owner: 'acme',
      repo: 'widgets',
      operatorHandle: '@op',
      notifications: {
        commentEvents: [],
        webhookEvents: ['epic-progress'],
      },
    },
  };
}

function makeProvider() {
  return { postComment: async () => {} };
}

describe('notify() — test-mode webhook guard (Story #2975)', () => {
  let originalFetch;
  let originalNodeEnv;
  let originalWebhookUrl;
  let originalAllowFlag;
  let fetchCalls;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalNodeEnv = process.env.NODE_ENV;
    originalWebhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    originalAllowFlag = process.env.MANDREL_ALLOW_TEST_WEBHOOKS;
    fetchCalls = [];
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, status: 200 };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalWebhookUrl === undefined) {
      delete process.env.NOTIFICATION_WEBHOOK_URL;
    } else {
      process.env.NOTIFICATION_WEBHOOK_URL = originalWebhookUrl;
    }
    if (originalAllowFlag === undefined) {
      delete process.env.MANDREL_ALLOW_TEST_WEBHOOKS;
    } else {
      process.env.MANDREL_ALLOW_TEST_WEBHOOKS = originalAllowFlag;
    }
  });

  it('suppresses webhook when NODE_ENV=test and caller did not pass webhookUrl, even when env URL is set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.NOTIFICATION_WEBHOOK_URL = SENTINEL_URL;
    delete process.env.MANDREL_ALLOW_TEST_WEBHOOKS;

    await notify(
      123,
      { severity: 'medium', message: 'wave done', event: 'epic-progress' },
      { config: makeConfig(), provider: makeProvider() },
    );

    assert.equal(
      fetchCalls.length,
      0,
      'guard must refuse to resolve env URL under NODE_ENV=test',
    );
  });

  it('allows webhook when caller explicitly passes webhookUrl (opt-in)', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.NOTIFICATION_WEBHOOK_URL;

    await notify(
      123,
      { severity: 'medium', message: 'wave done', event: 'epic-progress' },
      {
        config: makeConfig(),
        provider: makeProvider(),
        webhookUrl: 'https://explicit.example/hook',
      },
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://explicit.example/hook');
  });

  it('allows webhook when MANDREL_ALLOW_TEST_WEBHOOKS=1 escape hatch is set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.NOTIFICATION_WEBHOOK_URL = SENTINEL_URL;
    process.env.MANDREL_ALLOW_TEST_WEBHOOKS = '1';

    await notify(
      123,
      { severity: 'medium', message: 'wave done', event: 'epic-progress' },
      { config: makeConfig(), provider: makeProvider() },
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, SENTINEL_URL);
  });
});
