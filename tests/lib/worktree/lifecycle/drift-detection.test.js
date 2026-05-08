import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { sweepStaleLocks } from '../../../../.agents/scripts/lib/worktree/lifecycle/drift-detection.js';

let tmpRepo;
const warnings = [];
const ctx = () => ({
  repoRoot: tmpRepo,
  logger: {
    warn: (msg) => warnings.push(msg),
  },
});

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-detection-'));
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function writeLock(rel, ageMs = 0) {
  const abs = path.join(tmpRepo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '');
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(abs, mtime, mtime);
  }
  return abs;
}

describe('sweepStaleLocks', () => {
  it('returns empty arrays when there are no .git/ locks at all', async () => {
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 0 });
    assert.deepEqual(result, { removed: [], skipped: [] });
    assert.equal(warnings.length, 0);
  });

  it('removes locks older than maxAgeMs and reports them', async () => {
    const lockPath = writeLock('.git/index.lock', 600_000); // 10 min old
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 300_000 });
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].path, lockPath);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /stale-lock removed/);
  });

  it('skips locks fresher than maxAgeMs and keeps them on disk', async () => {
    const lockPath = writeLock('.git/index.lock', 0); // fresh
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 300_000 });
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].path, lockPath);
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(result.removed.length, 0);
  });

  it('walks the full canonical .git lock list', async () => {
    const targets = [
      '.git/index.lock',
      '.git/HEAD.lock',
      '.git/packed-refs.lock',
      '.git/config.lock',
      '.git/shallow.lock',
    ];
    for (const t of targets) writeLock(t, 999_999);
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 1 });
    assert.equal(result.removed.length, targets.length);
    for (const t of targets) {
      assert.equal(fs.existsSync(path.join(tmpRepo, t)), false);
    }
  });

  it('extends the candidate list with per-worktree admin locks', async () => {
    writeLock('.git/worktrees/story-100/index.lock', 999_999);
    writeLock('.git/worktrees/story-100/HEAD.lock', 999_999);
    writeLock('.git/worktrees/story-200/index.lock', 999_999);
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 1 });
    assert.equal(result.removed.length, 3);
  });

  it('absent .git/worktrees directory does not throw', async () => {
    // Only top-level .git/index.lock; no worktrees subdir.
    writeLock('.git/index.lock', 999_999);
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 1 });
    assert.equal(result.removed.length, 1);
  });

  it('default maxAgeMs is 5 minutes (300_000)', async () => {
    const oldLock = writeLock('.git/index.lock', 600_000);
    const freshLock = writeLock('.git/HEAD.lock', 60_000);
    const result = await sweepStaleLocks(ctx());
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].path, oldLock);
    assert.equal(fs.existsSync(freshLock), true);
  });

  it('logs a warning when unlink fails but does not throw', async () => {
    // Replace fs.unlinkSync within the module's import is awkward;
    // simulate a permission denial by creating a directory at the
    // expected lock path so unlink throws EISDIR.
    const lockPath = path.join(tmpRepo, '.git/index.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    // Set the dir's mtime old enough to trigger removal attempt.
    const old = new Date(Date.now() - 999_999);
    fs.utimesSync(lockPath, old, old);
    const result = await sweepStaleLocks(ctx(), { maxAgeMs: 1 });
    assert.equal(result.removed.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /stale-lock unlink failed/);
  });
});
