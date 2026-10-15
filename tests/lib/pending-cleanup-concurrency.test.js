/**
 * Story #5112 — the pending-cleanup manifest under concurrent writers.
 *
 * `recordPendingCleanup` (close reap) and `drainPendingCleanup` (plan boot)
 * run in different sessions against one file. The drain holds its snapshot
 * across awaited worktree removals, so anything recorded during that window
 * used to be erased by the drain's final whole-file write — losing exactly the
 * hand-off a reap had just decided it could not complete.
 *
 * The losing interleaving is reproduced deterministically by blocking the
 * drain inside `fsRm` on a deferred promise, recording a new entry while it is
 * parked, and then releasing it. No sleeps, no real concurrency.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  drainPendingCleanup,
  manifestPath,
  readManifest,
  recordPendingCleanup,
  removePendingCleanup,
} from '../../.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js';

let worktreeRoot;

/**
 * The manifest-adjacent lockfile name. Deliberately a test-local literal
 * rather than an import: the lock is internal to the manifest's
 * read-modify-write, so the module does not export its path. The tests below
 * only need it to *plant* a crashed holder's lockfile — every assertion about
 * the lock is made by observing the directory, not by calling into the module.
 */
const MANIFEST_LOCK = '.pending-cleanup.lock';

/** Lockfiles currently sitting in the worktree root. */
function strayLocks() {
  return fs.readdirSync(worktreeRoot).filter((n) => n.endsWith('.lock'));
}

/** `git` stub: every spawn succeeds, so removal hinges on `fsRm` alone. */
const OK_GIT = { gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }) };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Materialise a worktree directory so `removeStuckWorktreePath` engages. */
function plantWorktree(storyId) {
  const wtPath = path.join(worktreeRoot, `story-${storyId}`);
  fs.mkdirSync(wtPath, { recursive: true });
  fs.writeFileSync(path.join(wtPath, 'file.txt'), 'x', 'utf8');
  return wtPath;
}

beforeEach(() => {
  worktreeRoot = makeTempDir('pending-cleanup-concurrency-');
});

afterEach(() => {
  mock.restoreAll();
  try {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('pending-cleanup — an entry recorded mid-drain survives', () => {
  it('keeps a storyId recorded while the drain is parked inside fsRm', async () => {
    const drainingPath = plantWorktree(101);
    recordPendingCleanup(worktreeRoot, {
      storyId: 101,
      branch: 'story-101',
      path: drainingPath,
      push: true,
    });

    const gate = deferred();
    const entered = deferred();
    const drain = drainPendingCleanup({
      repoRoot: worktreeRoot,
      worktreeRoot,
      git: OK_GIT,
      fsRm: async (target, opts) => {
        entered.resolve();
        await gate.promise;
        await fs.promises.rm(target, opts);
      },
    });

    // The drain has read its snapshot ([101]) and is parked mid-removal.
    await entered.promise;
    const latePath = plantWorktree(202);
    recordPendingCleanup(worktreeRoot, {
      storyId: 202,
      branch: 'story-202',
      path: latePath,
      push: false,
    });

    gate.resolve();
    const result = await drain;

    assert.deepEqual(result.drained, [101]);
    const after = readManifest(worktreeRoot);
    const ids = after.map((e) => e.storyId);
    assert.ok(
      ids.includes(202),
      `the mid-drain entry survived the drain's write (got ${JSON.stringify(ids)})`,
    );
    assert.ok(!ids.includes(101), 'the drained entry was cleared');
    // The late row is intact, not a husk: the merge preserves the whole entry.
    const late = after.find((e) => e.storyId === 202);
    assert.equal(late.branch, 'story-202');
    assert.equal(late.path, latePath);
    assert.equal(late.attempts, 0);
  });

  it('still re-writes the rows its own pass re-computed', async () => {
    const stuck = plantWorktree(303);
    recordPendingCleanup(worktreeRoot, {
      storyId: 303,
      branch: 'story-303',
      path: stuck,
      push: false,
    });

    const result = await drainPendingCleanup({
      repoRoot: worktreeRoot,
      worktreeRoot,
      git: OK_GIT,
      fsRm: async () => {
        throw new Error('EBUSY: resource busy or locked');
      },
    });

    assert.deepEqual(result.stillPending, [303]);
    const after = readManifest(worktreeRoot);
    assert.equal(after.length, 1);
    assert.equal(
      after[0].attempts,
      1,
      'the recomputed row won, not the stale one',
    );
  });
});

describe('pending-cleanup — the manifest is written via rename', () => {
  it('never writes the manifest path directly (no partial file is observable)', () => {
    const target = manifestPath(worktreeRoot);
    const writes = [];
    const renames = [];
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    mock.method(fs, 'writeFileSync', (p, ...rest) => {
      writes.push(String(p));
      return realWrite(p, ...rest);
    });
    mock.method(fs, 'renameSync', (from, to) => {
      renames.push([String(from), String(to)]);
      return realRename(from, to);
    });

    recordPendingCleanup(worktreeRoot, {
      storyId: 404,
      branch: 'story-404',
      path: path.join(worktreeRoot, 'story-404'),
      push: false,
    });

    assert.equal(
      writes.includes(target),
      false,
      'the manifest itself was never opened for writing',
    );
    const manifestWrites = writes.filter((p) => p.startsWith(target));
    assert.equal(manifestWrites.length, 1);
    assert.match(manifestWrites[0], /\.\d+\.tmp$/, 'pid-scoped temp file');
    assert.deepEqual(renames, [[manifestWrites[0], target]]);
    assert.equal(readManifest(worktreeRoot).length, 1);
  });

  it('leaves no temp file behind after a successful write', () => {
    recordPendingCleanup(worktreeRoot, {
      storyId: 505,
      branch: 'story-505',
      path: path.join(worktreeRoot, 'story-505'),
      push: false,
    });
    const leftovers = fs
      .readdirSync(worktreeRoot)
      .filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('reaps the temp file and propagates when the rename fails', () => {
    const realRename = fs.renameSync;
    mock.method(fs, 'renameSync', () => {
      const err = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    });

    assert.throws(
      () =>
        recordPendingCleanup(worktreeRoot, {
          storyId: 808,
          branch: 'story-808',
          path: path.join(worktreeRoot, 'story-808'),
          push: false,
        }),
      /EXDEV/,
    );

    // No half-written artifact is left where a reader could pick it up:
    // neither the manifest nor the abandoned temp file survives.
    assert.equal(fs.existsSync(manifestPath(worktreeRoot)), false);
    assert.deepEqual(
      fs.readdirSync(worktreeRoot).filter((n) => n.endsWith('.tmp')),
      [],
    );
    mock.restoreAll();
    assert.equal(fs.renameSync, realRename);
  });

  it('reads a torn manifest as empty rather than throwing', () => {
    fs.writeFileSync(manifestPath(worktreeRoot), '[{"storyId":1,', 'utf8');
    assert.deepEqual(readManifest(worktreeRoot), []);
  });
});

describe('pending-cleanup — read-modify-write runs under a manifest lock', () => {
  it('releases the lock after each mutation', () => {
    recordPendingCleanup(worktreeRoot, {
      storyId: 606,
      branch: 'story-606',
      path: path.join(worktreeRoot, 'story-606'),
      push: false,
    });
    assert.deepEqual(strayLocks(), [], 'lock released after record');

    removePendingCleanup(worktreeRoot, 606);
    assert.deepEqual(strayLocks(), [], 'lock released after remove');
    assert.deepEqual(readManifest(worktreeRoot), []);
  });

  it('still completes the write when the lock is already held (never wedges)', () => {
    // A crashed holder's lockfile must not be able to stall a reap hand-off:
    // the lock damps contention, the merge is what makes losing it harmless.
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const foreignLock = path.join(worktreeRoot, MANIFEST_LOCK);
    fs.writeFileSync(foreignLock, 'someone-else\n', 'utf8');

    const entry = recordPendingCleanup(worktreeRoot, {
      storyId: 707,
      branch: 'story-707',
      path: path.join(worktreeRoot, 'story-707'),
      push: false,
    });

    assert.equal(entry.storyId, 707);
    assert.deepEqual(
      readManifest(worktreeRoot).map((e) => e.storyId),
      [707],
    );
    // The foreign lockfile is untouched — we never released what we did not take.
    assert.equal(fs.existsSync(foreignLock), true);
  });
});
