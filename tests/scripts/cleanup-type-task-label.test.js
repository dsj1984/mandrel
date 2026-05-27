/**
 * Contract tests for `.agents/scripts/cleanup-type-task-label.js`.
 *
 * Story #3103 / Task #3115 (Epic #3078). Exercises the three AC paths:
 *   1. `--dry-run` does not invoke any GitHub mutation method.
 *   2. Fresh removal returns ok: true with action 'removed'.
 *   3. Re-run against a repo without the label returns ok: true with
 *      action 'no-op' (idempotent).
 *
 * Mocks the provider seam — the script's `cleanupTypeTaskLabel({ provider })`
 * option lets us inject a stub with a tracked `deleteLabel` method.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanupTypeTaskLabel,
  isLabelNotFoundError,
  parseArgs,
} from '../../.agents/scripts/cleanup-type-task-label.js';

const FAKE_CONFIG = { github: { owner: 'acme', repo: 'consumer' } };

function makeProvider({ absent = false } = {}) {
  const calls = [];
  return {
    calls,
    async deleteLabel(name) {
      calls.push(name);
      // The provider abstraction normalizes "label not found" into
      // `{ removed: false }` so the orchestrator stays decoupled from
      // transport-specific error shapes (see `defaultProvider` /
      // `isLabelNotFoundError`).
      return { removed: !absent };
    },
  };
}

test('parseArgs detects --dry-run flag', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
});

test('isLabelNotFoundError matches HTTP 404 stderr', () => {
  const err = new Error('gh exec failed');
  err.stderr = 'gh: HTTP 404: Not Found';
  assert.equal(isLabelNotFoundError(err), true);
});

test('isLabelNotFoundError ignores unrelated errors', () => {
  const err = new Error('Network timeout');
  assert.equal(isLabelNotFoundError(err), false);
});

test('dry-run does not invoke any GitHub mutation', async () => {
  const provider = makeProvider();
  const result = await cleanupTypeTaskLabel({
    dryRun: true,
    config: FAKE_CONFIG,
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'dry-run');
  assert.equal(result.label, 'type::task');
  assert.equal(provider.calls.length, 0);
});

test('fresh removal returns ok: true with action "removed"', async () => {
  const provider = makeProvider();
  const result = await cleanupTypeTaskLabel({
    config: FAKE_CONFIG,
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'removed');
  assert.equal(result.label, 'type::task');
  assert.deepEqual(provider.calls, ['type::task']);
});

test('idempotent re-run (label absent) returns ok: true with action "no-op"', async () => {
  const provider = makeProvider({ absent: true });
  const result = await cleanupTypeTaskLabel({
    config: FAKE_CONFIG,
    provider,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'no-op');
  assert.match(result.message, /no-op/);
  assert.deepEqual(provider.calls, ['type::task']);
});

test('missing github config throws a clear error', async () => {
  await assert.rejects(
    () => cleanupTypeTaskLabel({ config: {}, provider: makeProvider() }),
    /github\.owner.*github\.repo/,
  );
});

test('non-404 provider errors propagate', async () => {
  const provider = {
    async deleteLabel() {
      throw new Error('rate limited');
    },
  };
  await assert.rejects(
    () => cleanupTypeTaskLabel({ config: FAKE_CONFIG, provider }),
    /rate limited/,
  );
});
