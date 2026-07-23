// tests/lib/test-env.test.js
/**
 * Unit tests for the shared test-env bootstrap (Story #2975 / #4696 / #4711).
 *
 * `run-tests.js` and `run-test-profile.js` use `buildWebhookSafeTestEnv` to
 * scrub `NOTIFICATION_WEBHOOK_URL` from the test child env so a real `.env`
 * webhook never reaches the test runtime, and to arm the per-process scratch
 * tempRoot. `ensureTestScratchTempRoot` — the single point of failure for the
 * temp-isolation fix — is covered directly via its injectable `mkdtemp` seam.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  anchorTempRoot,
  TEST_TEMP_ROOT_ENV,
} from '../../.agents/scripts/lib/config/temp-paths.js';
import {
  _clearTestScratchTempRootCache,
  buildWebhookSafeTestEnv,
  ensureTestScratchTempRoot,
} from '../../.agents/scripts/lib/test-env.js';

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

describe('ensureTestScratchTempRoot (Story #4696 / #4711)', () => {
  const FAKE_SCRATCH = path.join(os.tmpdir(), 'mandrel-test-temp-FAKE');

  beforeEach(() => {
    _clearTestScratchTempRootCache();
  });
  afterEach(() => {
    _clearTestScratchTempRootCache();
  });

  it('reuses an absolute MANDREL_TEST_TEMP_ROOT from the base env verbatim', () => {
    const armed = path.join(os.tmpdir(), 'already-armed');
    const result = ensureTestScratchTempRoot(
      { [TEST_TEMP_ROOT_ENV]: armed },
      {
        mkdtemp: () => {
          throw new Error('must not create a new dir when one is armed');
        },
      },
    );
    assert.equal(result, armed);
  });

  it('ignores an empty or relative override and creates a scratch dir', () => {
    const prefixes = [];
    const mkdtemp = (prefix) => {
      prefixes.push(prefix);
      return FAKE_SCRATCH;
    };
    assert.equal(
      ensureTestScratchTempRoot({ [TEST_TEMP_ROOT_ENV]: '' }, { mkdtemp }),
      FAKE_SCRATCH,
    );
    _clearTestScratchTempRootCache();
    assert.equal(
      ensureTestScratchTempRoot(
        { [TEST_TEMP_ROOT_ENV]: 'relative/temp' },
        { mkdtemp },
      ),
      FAKE_SCRATCH,
    );
    assert.deepEqual(prefixes, [
      path.join(os.tmpdir(), 'mandrel-test-temp-'),
      path.join(os.tmpdir(), 'mandrel-test-temp-'),
    ]);
  });

  it('creates the scratch dir once per process (idempotent via the memo)', () => {
    let calls = 0;
    const mkdtemp = () => {
      calls += 1;
      return FAKE_SCRATCH;
    };
    const first = ensureTestScratchTempRoot({}, { mkdtemp });
    const second = ensureTestScratchTempRoot({}, { mkdtemp });
    assert.equal(calls, 1);
    assert.equal(first, FAKE_SCRATCH);
    assert.equal(second, FAKE_SCRATCH);
  });

  it('propagates into anchorTempRoot: the armed env bag redirects relative roots', () => {
    const env = buildWebhookSafeTestEnv({ PATH: '/usr/bin' });
    const scratch = env[TEST_TEMP_ROOT_ENV];
    assert.equal(typeof scratch, 'string');
    assert.ok(path.isAbsolute(scratch));
    assert.equal(anchorTempRoot('temp', env), path.join(scratch, 'temp'));
  });
});
