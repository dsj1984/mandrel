import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rm as fsPromisesRm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  drainPendingCleanup,
  MAX_SWEEP_ATTEMPTS,
  manifestPath,
  readManifest,
  recordPendingCleanup,
  removePendingCleanup,
} from '../../../.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js';

function quietLogger() {
  const sink = { info: [], warn: [], error: [] };
  return {
    sink,
    logger: {
      info: (m) => sink.info.push(m),
      warn: (m) => sink.warn.push(m),
      error: (m) => sink.error.push(m),
    },
  };
}

function tmpWorktreeRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const wtRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  return { tmp, wtRoot };
}

test('recordPendingCleanup: writes a fresh manifest entry', () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const entry = recordPendingCleanup(wtRoot, {
      storyId: 42,
      branch: 'story-42',
      path: path.join(wtRoot, 'story-42'),
      push: true,
    });
    assert.equal(entry.storyId, 42);
    assert.equal(entry.attempts, 0);
    assert.ok(entry.firstFailedAt);
    assert.equal(entry.firstFailedAt, entry.lastFailedAt);

    const onDisk = readManifest(wtRoot);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].storyId, 42);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('recordPendingCleanup: increments attempts and updates lastFailedAt on repeat', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const first = recordPendingCleanup(wtRoot, {
      storyId: 7,
      branch: 'story-7',
      path: path.join(wtRoot, 'story-7'),
    });
    assert.equal(first.attempts, 0);
    // Force a distinct timestamp.
    await new Promise((r) => setTimeout(r, 10));
    const second = recordPendingCleanup(wtRoot, {
      storyId: 7,
      branch: 'story-7',
      path: path.join(wtRoot, 'story-7'),
    });
    assert.equal(second.attempts, 1);
    assert.equal(second.firstFailedAt, first.firstFailedAt);
    assert.notEqual(second.lastFailedAt, first.lastFailedAt);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removePendingCleanup: drops entry and deletes manifest when empty', () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    recordPendingCleanup(wtRoot, {
      storyId: 1,
      branch: 'story-1',
      path: path.join(wtRoot, 'story-1'),
    });
    removePendingCleanup(wtRoot, 1);
    assert.equal(fs.existsSync(manifestPath(wtRoot)), false);
    assert.deepEqual(readManifest(wtRoot), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: empty manifest returns empty result without calling git', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const calls = [];
    const git = {
      gitSpawn: (_cwd, ...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: async () => {
        throw new Error('should not be called');
      },
      logger: quietLogger().logger,
    });
    assert.deepEqual(res, {
      drained: [],
      drainedDetails: [],
      persistent: [],
      persistentDetails: [],
      stillPending: [],
      stillPendingDetails: [],
    });
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: removes entry when Stage 1 retry now succeeds', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-100');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 100,
      branch: 'story-100',
      path: wtPath,
      push: true,
    });

    const calls = [];
    const git = {
      gitSpawn: (_cwd, ...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: fsPromisesRm,
      logger: quietLogger().logger,
    });
    assert.deepEqual(res.drained, [100]);
    assert.deepEqual(res.drainedDetails, [
      {
        storyId: 100,
        path: wtPath,
        branch: 'story-100',
        localBranchDeleted: true,
        remoteBranchDeleted: true,
      },
    ]);
    assert.deepEqual(res.persistent, []);
    assert.deepEqual(res.stillPending, []);
    assert.equal(fs.existsSync(manifestPath(wtRoot)), false);
    assert.ok(
      calls.some(
        (a) =>
          a[0] === 'worktree' &&
          a[1] === 'remove' &&
          !a.includes('--force') &&
          a.some(
            (x) =>
              typeof x === 'string' &&
              x.replace(/\\/g, '/').includes('story-100'),
          ),
      ),
      'expect plain git worktree remove before optional --force',
    );
    assert.ok(
      calls.some((a) => a[0] === 'worktree' && a[1] === 'prune'),
      'sweep must run worktree prune after removal',
    );
    assert.ok(
      calls.some(
        (a) => a[0] === 'branch' && a[1] === '-D' && a[2] === 'story-100',
      ),
      'sweep must run branch -D',
    );
    assert.ok(
      calls.some(
        (a) =>
          a[0] === 'push' &&
          a.includes('--delete') &&
          a.some((x) => typeof x === 'string' && x.includes('story-100')),
      ),
      'push=true should trigger remote branch delete',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: never-clearing lock promotes to persistent after MAX_SWEEP_ATTEMPTS', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-77');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 77,
      branch: 'story-77',
      path: wtPath,
    });
    // Simulate two prior sweep failures.
    const manifest = readManifest(wtRoot);
    manifest[0].attempts = MAX_SWEEP_ATTEMPTS - 1;
    fs.writeFileSync(
      manifestPath(wtRoot),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const { logger, sink } = quietLogger();
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: {
        gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
      },
      fsRm: async () => {
        const err = new Error('EBUSY: still locked');
        err.code = 'EBUSY';
        throw err;
      },
      logger,
    });
    assert.deepEqual(res.drained, []);
    assert.deepEqual(res.persistent, [77]);
    assert.equal(res.persistentDetails.length, 1);
    assert.equal(res.persistentDetails[0].storyId, 77);
    assert.deepEqual(res.stillPending, []);
    assert.ok(
      sink.error.some((m) => m.includes('persistent-lock')),
      'expected OPERATOR ACTION REQUIRED: persistent-lock log line',
    );
    // Entry must stay in the manifest so the signal persists next sweep.
    const post = readManifest(wtRoot);
    assert.equal(post.length, 1);
    assert.equal(post[0].attempts, MAX_SWEEP_ATTEMPTS);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: falls back to git worktree remove --force when plain remove fails', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-30');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 30,
      branch: 'story-30',
      path: wtPath,
      push: false,
    });
    let firstRemoveSeen = false;
    const calls = [];
    const git = {
      gitSpawn: (_cwd, ...args) => {
        calls.push(args);
        if (
          args[0] === 'worktree' &&
          args[1] === 'remove' &&
          !args.includes('--force')
        ) {
          if (!firstRemoveSeen) {
            firstRemoveSeen = true;
            // Simulate: command "fails" but the fsRm picks up the leftover.
            return {
              status: 1,
              stdout: '',
              stderr: 'cannot remove worktree (locked)',
            };
          }
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: fsPromisesRm,
      logger: quietLogger().logger,
    });
    assert.deepEqual(res.drained, [30]);
    assert.ok(
      calls.some((a) => a[0] === 'worktree' && a.includes('--force')),
      'expected fallback to git worktree remove --force',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: records error when path persists after worktree-remove + fs.rm', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-31');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 31,
      branch: 'story-31',
      path: wtPath,
      push: false,
    });
    const git = {
      // Both `remove` and `remove --force` return non-zero so we attempt fs.rm.
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return { status: 1, stdout: '', stderr: 'locked' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    // fsRm "succeeds" but the directory is still on disk → triggers the
    // path-still-exists branch.
    const fakeFsRm = async () => {
      /* no-op: directory stays on disk */
    };
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: fakeFsRm,
      logger: quietLogger().logger,
    });
    assert.deepEqual(res.drained, []);
    assert.equal(res.stillPending.length + res.persistent.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: logs and records false when branch -D returns a non-not-found error', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-42');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 42,
      branch: 'story-42',
      path: wtPath,
      push: false,
    });
    const { logger, sink } = quietLogger();
    const git = {
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'branch' && args[1] === '-D') {
          return {
            status: 128,
            stdout: '',
            stderr: 'fatal: weird branch boom',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: fsPromisesRm,
      logger,
    });
    assert.deepEqual(res.drained, [42]);
    assert.equal(res.drainedDetails[0].localBranchDeleted, false);
    assert.ok(
      sink.warn.some((m) => m.includes('branch -D story-42 failed')),
      'expected sweep warn for non-idempotent branch delete failure',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: logs and records false when push --delete returns a non-not-found error', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-43');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 43,
      branch: 'story-43',
      path: wtPath,
      push: true,
    });
    const { logger, sink } = quietLogger();
    const git = {
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'push' && args.includes('--delete')) {
          return {
            status: 128,
            stdout: '',
            stderr: 'fatal: remote rejected delete',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: fsPromisesRm,
      logger,
    });
    assert.deepEqual(res.drained, [43]);
    assert.equal(res.drainedDetails[0].remoteBranchDeleted, false);
    assert.ok(
      sink.warn.some((m) => m.includes('push --delete story-43 failed')),
      'expected sweep warn for remote delete failure',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drainPendingCleanup: increments attempts and keeps entry when below max', async () => {
  const { tmp, wtRoot } = tmpWorktreeRoot();
  try {
    const wtPath = path.join(wtRoot, 'story-55');
    fs.mkdirSync(wtPath, { recursive: true });
    recordPendingCleanup(wtRoot, {
      storyId: 55,
      branch: 'story-55',
      path: wtPath,
    });
    const { logger, sink } = quietLogger();
    const res = await drainPendingCleanup({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git: {
        gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
      },
      fsRm: async () => {
        throw new Error('EBUSY');
      },
      logger,
    });
    assert.deepEqual(res.drained, []);
    assert.deepEqual(res.persistent, []);
    assert.deepEqual(res.stillPending, [55]);
    assert.equal(res.stillPendingDetails.length, 1);
    assert.equal(res.stillPendingDetails[0].storyId, 55);
    assert.ok(
      !sink.error.some((m) => m.includes('persistent-lock')),
      'must not escalate below MAX_SWEEP_ATTEMPTS',
    );
    const post = readManifest(wtRoot);
    assert.equal(post[0].attempts, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
