// tests/lib/test-env.test.js
/**
 * Unit test for buildWebhookSafeTestEnv (Story #2975).
 *
 * `run-tests.js` and `run-test-profile.js` use this helper to scrub
 * `NOTIFICATION_WEBHOOK_URL` from the test child env so a real `.env`
 * webhook never reaches the test runtime.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWebhookSafeTestEnv } from '../../.agents/scripts/lib/test-env.js';

describe('buildWebhookSafeTestEnv', () => {
  it('deletes NOTIFICATION_WEBHOOK_URL by default', () => {
    const env = buildWebhookSafeTestEnv({
      NOTIFICATION_WEBHOOK_URL: 'https://hooks.slack.com/services/X/Y/Z',
      PATH: '/usr/bin',
    });
    assert.equal(env.NOTIFICATION_WEBHOOK_URL, undefined);
    assert.equal(env.PATH, '/usr/bin');
  });

  it('sets NODE_ENV=test when unset', () => {
    const env = buildWebhookSafeTestEnv({ PATH: '/usr/bin' });
    assert.equal(env.NODE_ENV, 'test');
  });

  it('preserves an explicit NODE_ENV the caller already set', () => {
    const env = buildWebhookSafeTestEnv({ NODE_ENV: 'ci', PATH: '/usr/bin' });
    assert.equal(env.NODE_ENV, 'ci');
  });

  it('keeps NOTIFICATION_WEBHOOK_URL when MANDREL_ALLOW_TEST_WEBHOOKS=1', () => {
    const env = buildWebhookSafeTestEnv({
      NOTIFICATION_WEBHOOK_URL: 'https://sandbox.example/hook',
      MANDREL_ALLOW_TEST_WEBHOOKS: '1',
    });
    assert.equal(env.NOTIFICATION_WEBHOOK_URL, 'https://sandbox.example/hook');
  });

  it('drops every GIT_* variable (worktree pre-push GIT_DIR poisoning, #4580)', () => {
    const env = buildWebhookSafeTestEnv({
      GIT_DIR: '/repo/.git/worktrees/story-1',
      GIT_WORK_TREE: '/repo',
      GIT_INDEX_FILE: '/repo/.git/worktrees/story-1/index',
      GITHUB_TOKEN: 'keep-me',
      PATH: '/usr/bin',
    });
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    assert.equal(env.GIT_INDEX_FILE, undefined);
    assert.equal(env.GITHUB_TOKEN, 'keep-me');
    assert.equal(env.PATH, '/usr/bin');
  });

  it('does not mutate the input env object', () => {
    const input = {
      NOTIFICATION_WEBHOOK_URL: 'https://hooks.slack.com/services/X/Y/Z',
    };
    buildWebhookSafeTestEnv(input);
    assert.equal(
      input.NOTIFICATION_WEBHOOK_URL,
      'https://hooks.slack.com/services/X/Y/Z',
    );
  });
});
