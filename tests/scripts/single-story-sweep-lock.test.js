import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  acquireLockWithWait,
  acquireSweepLock,
  isLockStale,
  readLockMtime,
} from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-lock-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('readLockMtime', () => {
  it('returns null when the file does not exist', () => {
    assert.equal(readLockMtime(path.join(tmpDir, 'missing.lock')), null);
  });

  it('returns the file mtime when the file exists', () => {
    const p = path.join(tmpDir, 'present.lock');
    fs.writeFileSync(p, 'owner');
    const mtime = readLockMtime(p);
    assert.equal(typeof mtime, 'number');
    assert.ok(mtime > 0);
  });
});

describe('isLockStale', () => {
  it('returns false when no mtime (no lock held)', () => {
    assert.equal(isLockStale(null, Date.now(), 60_000), false);
  });

  it('returns false when mtime is within the timeout window', () => {
    const now = 1_000_000;
    assert.equal(isLockStale(now - 30_000, now, 60_000), false);
  });

  it('returns true when mtime is older than the timeout window', () => {
    const now = 1_000_000;
    assert.equal(isLockStale(now - 120_000, now, 60_000), true);
  });
});

describe('acquireSweepLock', () => {
  it('acquires when no lockfile exists', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    const result = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
    assert.equal(result.acquired, true);
    assert.equal(typeof result.release, 'function');
    assert.equal(fs.existsSync(lockPath), true);
    result.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('release is idempotent — calling twice is a no-op', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    const result = acquireSweepLock({ lockPath });
    assert.equal(result.acquired, true);
    result.release();
    // Second release must not throw.
    result.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('returns contended when another holder is active', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    const a = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
    assert.equal(a.acquired, true);
    const b = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
    assert.equal(b.acquired, false);
    assert.equal(b.reason, 'contended');
    a.release();
  });

  it('treats a stale lockfile as expired and acquires', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    fs.writeFileSync(lockPath, 'stale-owner');
    // Mark the file as old enough to be stale.
    const oldTime = Date.now() / 1000 - 120;
    fs.utimesSync(lockPath, oldTime, oldTime);
    const result = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
    assert.equal(result.acquired, true);
    result.release();
  });

  it('does NOT treat a fresh lockfile as stale (still contended)', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    fs.writeFileSync(lockPath, 'fresh-owner');
    const result = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'contended');
  });

  it('returns error when lockPath is missing', () => {
    const result = acquireSweepLock({});
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'error');
    assert.match(result.detail, /lockPath is required/);
  });

  it('writes the ownerId into the lockfile body', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    const result = acquireSweepLock({ lockPath, ownerId: 'test-owner-42' });
    assert.equal(result.acquired, true);
    assert.equal(result.ownerId, 'test-owner-42');
    const body = fs.readFileSync(lockPath, 'utf-8');
    assert.match(body, /test-owner-42/);
    result.release();
  });
});

describe('acquireLockWithWait (Story #4622)', () => {
  it('acquires immediately when the lock is free', async () => {
    const lockPath = path.join(tmpDir, 'wait.lock');
    let slept = 0;
    const res = await acquireLockWithWait({
      lockPath,
      waitMs: 1_000,
      pollMs: 50,
      sleepFn: async () => {
        slept += 1;
      },
    });
    assert.equal(res.acquired, true);
    assert.equal(slept, 0, 'no wait when the lock is free');
    res.release();
  });

  it('polls until a contended lock is released, then acquires', async () => {
    const lockPath = path.join(tmpDir, 'wait.lock');
    const holder = acquireSweepLock({ lockPath });
    assert.equal(holder.acquired, true);

    let now = 0;
    const nowFn = () => now;
    // Release the holder on the second poll so the wrapper's retry succeeds.
    let sleeps = 0;
    const sleepFn = async (ms) => {
      now += ms;
      sleeps += 1;
      if (sleeps === 2) holder.release();
    };

    const res = await acquireLockWithWait({
      lockPath,
      waitMs: 10_000,
      pollMs: 100,
      nowFn,
      sleepFn,
    });
    assert.equal(res.acquired, true, 'acquires once the holder releases');
    assert.ok(sleeps >= 2, 'waited across at least two polls');
    res.release();
  });

  it('gives up with contended-after-wait when the deadline passes (never load-bearing)', async () => {
    const lockPath = path.join(tmpDir, 'wait.lock');
    const holder = acquireSweepLock({ lockPath });
    assert.equal(holder.acquired, true);

    let now = 0;
    const res = await acquireLockWithWait({
      lockPath,
      waitMs: 300,
      pollMs: 100,
      // A fresh mtime every check so the lock never reads stale.
      timeoutMs: 60_000,
      nowFn: () => now,
      sleepFn: async (ms) => {
        now += ms;
      },
    });
    assert.equal(res.acquired, false);
    assert.equal(res.reason, 'contended-after-wait');
    holder.release();
  });

  it('short-circuits on a hard error instead of spinning', async () => {
    const res = await acquireLockWithWait({
      lockPath: '',
      waitMs: 1_000,
      sleepFn: async () => {
        throw new Error('sleep should never be called on a hard error');
      },
    });
    assert.equal(res.acquired, false);
    assert.equal(res.reason, 'error');
  });
});
