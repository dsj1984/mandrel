import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  claimLockEventSink,
  createLockEventChannel,
  lockEventHooks,
  summarizeLockEvents,
} from '../../.agents/scripts/lib/close-lock-events.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const CLOSE_LOCK_EVENTS_FILE_ENV = 'MANDREL_CLOSE_LOCK_EVENTS_FILE';

/**
 * Story #5642 — the channel close reads `lockWait` / `suiteTimings` from.
 * A child claims it out of its env before spawning a suite, so nothing a
 * test prints or spawns can reach it.
 */
describe('close-lock-events', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir('close-lock-events-');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a claimed sink writes to the channel and removes the variable from env', () => {
    const channel = createLockEventChannel({ dir });
    const env = { ...channel.env, OTHER: '1' };
    const emit = claimLockEventSink(env);
    assert.equal(env[CLOSE_LOCK_EVENTS_FILE_ENV], undefined);
    assert.equal(env.OTHER, '1');
    emit({ kind: 'lock-wait', waitedSeconds: 3, expired: false });
    assert.deepEqual(channel.read(), [
      { kind: 'lock-wait', waitedSeconds: 3, expired: false },
    ]);
    channel.dispose();
    assert.equal(fs.existsSync(channel.file), false);
  });

  it('a second claim from the same env gets a no-op sink', () => {
    const channel = createLockEventChannel({ dir });
    const env = { ...channel.env };
    claimLockEventSink(env);
    claimLockEventSink(env)({ kind: 'lock-wait', waitedSeconds: 1 });
    assert.deepEqual(channel.read(), []);
  });

  it('reads nothing from a channel never written, and skips malformed or foreign lines', () => {
    const channel = createLockEventChannel({ dir });
    assert.deepEqual(channel.read(), []);
    fs.writeFileSync(
      channel.file,
      [
        'not json',
        JSON.stringify({ kind: 'other', waitedSeconds: 9 }),
        'null',
        JSON.stringify({ kind: 'lock-wait', waitedSeconds: 2, expired: true }),
        '',
      ].join('\n'),
    );
    assert.deepEqual(channel.read(), [
      { kind: 'lock-wait', waitedSeconds: 2, expired: true },
    ]);
  });

  it('an unwritable channel loses the event without throwing', () => {
    const emit = claimLockEventSink({
      [CLOSE_LOCK_EVENTS_FILE_ENV]: `${dir}/missing/dir/events.ndjson`,
    });
    assert.doesNotThrow(() => emit({ kind: 'lock-wait', waitedSeconds: 1 }));
  });

  it('summarizes waits (summed, sticky expiry, last holder) and the last timings', () => {
    const holder = { ownerId: 'pid-1-2', pid: 1, ageSeconds: 5 };
    assert.deepEqual(summarizeLockEvents([]), {
      lockWait: null,
      suiteTimings: null,
    });
    assert.deepEqual(
      summarizeLockEvents([
        { kind: 'lock-wait', waitedSeconds: 10, expired: true, holder },
        { kind: 'suite-timings', lockWaitMs: 1, hostWaitMs: 2, testRunMs: 3 },
        { kind: 'lock-wait', waitedSeconds: 5, expired: false },
        { kind: 'suite-timings', lockWaitMs: 4, testRunMs: 6 },
      ]),
      {
        lockWait: { waitedSeconds: 15, expired: true, holder },
        suiteTimings: { lockWaitMs: 4, hostWaitMs: null, testRunMs: 6 },
      },
    );
  });

  it('lockEventHooks tags the lock layer and suite callbacks with their kinds', () => {
    const events = [];
    const hooks = lockEventHooks((e) => events.push(e));
    hooks.onLockOutcome({ waitedSeconds: 4, expired: false });
    hooks.onTimings({ lockWaitMs: 4000, hostWaitMs: null, testRunMs: 10 });
    assert.deepEqual(events, [
      { kind: 'lock-wait', waitedSeconds: 4, expired: false },
      {
        kind: 'suite-timings',
        lockWaitMs: 4000,
        hostWaitMs: null,
        testRunMs: 10,
      },
    ]);
  });
});
