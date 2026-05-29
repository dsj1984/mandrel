// tests/contract/notifications/test-mode-webhook-guard.test.js
/**
 * Story #2975 / Story #3342 — guarantee that tests do NOT POST to the
 * operator's real Slack webhook even when `.env` sets
 * `NOTIFICATION_WEBHOOK_URL`.
 *
 * The NODE_ENV=test library band-aid that previously lived in `notify.js`
 * has been removed (Story #3342): it conflated "we are running tests" with
 * "do not deliver", which made the signing and error branches untestable
 * without an env guard. The surviving defenses are:
 *
 *   1. `run-tests.js` scrubs `NOTIFICATION_WEBHOOK_URL` from the test
 *      child env and sets `NODE_ENV=test` (see `buildWebhookSafeTestEnv`,
 *      covered by tests/lib/test-env.test.js). Tests inherit a clean env,
 *      so `resolveWebhookUrl()` returns nothing and the webhook never
 *      fires.
 *   2. `notify()` accepts an injected `opts.fetchImpl`. Tests that want to
 *      exercise the webhook POST inject a fake fetch, so the request never
 *      reaches the real network and never touches `globalThis.fetch`.
 *
 * This contract test exercises both defenses directly:
 *   - With an env URL set but a fake `fetchImpl` injected, the POST is
 *     captured by the fake and `globalThis.fetch` is never called.
 *   - With no env URL (the scrubbed-runner condition), the webhook is
 *     suppressed because no URL resolves — independent of NODE_ENV.
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

describe('notify() — webhook isolation via injected fetch (Story #3342)', () => {
  let originalFetch;
  let originalNodeEnv;
  let originalWebhookUrl;
  let globalFetchCalls;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalNodeEnv = process.env.NODE_ENV;
    originalWebhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    globalFetchCalls = [];
    // A tripwire: if any code path falls through to the real global fetch,
    // this records it so the assertions below can fail loudly.
    global.fetch = async (url, opts) => {
      globalFetchCalls.push({ url, opts });
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
  });

  it('injected fetchImpl captures the POST and never touches global fetch, even when env URL is set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.NOTIFICATION_WEBHOOK_URL = SENTINEL_URL;

    const injectedCalls = [];
    const fakeFetch = async (url, opts) => {
      injectedCalls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    await notify(
      123,
      { severity: 'medium', message: 'wave done', event: 'epic-progress' },
      { config: makeConfig(), provider: makeProvider(), fetchImpl: fakeFetch },
    );

    // The env URL resolves (the NODE_ENV band-aid is gone) but the POST is
    // routed through the injected fake, not the real global fetch.
    assert.equal(injectedCalls.length, 1, 'injected fetch handles the POST');
    assert.equal(injectedCalls[0].url, SENTINEL_URL);
    assert.equal(
      globalFetchCalls.length,
      0,
      'global fetch is never reached when fetchImpl is injected',
    );
  });

  it('suppresses webhook when no URL resolves (scrubbed-runner condition), regardless of NODE_ENV', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.NOTIFICATION_WEBHOOK_URL;

    await notify(
      123,
      { severity: 'medium', message: 'wave done', event: 'epic-progress' },
      { config: makeConfig(), provider: makeProvider() },
    );

    assert.equal(
      globalFetchCalls.length,
      0,
      'no URL resolved → webhook suppressed → global fetch untouched',
    );
  });

  it('honors an explicitly passed webhookUrl through the injected fetch', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.NOTIFICATION_WEBHOOK_URL;

    const injectedCalls = [];
    const fakeFetch = async (url, opts) => {
      injectedCalls.push({ url, opts });
      return { ok: true, status: 200 };
    };

    await notify(
      123,
      { severity: 'medium', message: 'wave done', event: 'epic-progress' },
      {
        config: makeConfig(),
        provider: makeProvider(),
        webhookUrl: 'https://explicit.example/hook',
        fetchImpl: fakeFetch,
      },
    );

    assert.equal(injectedCalls.length, 1);
    assert.equal(injectedCalls[0].url, 'https://explicit.example/hook');
    assert.equal(globalFetchCalls.length, 0);
  });
});
