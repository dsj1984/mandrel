import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  buildSummaryLine,
  runBootSweep,
} from '../../.agents/scripts/boot-sweep.js';
import { gitSpawn } from '../../.agents/scripts/lib/git-utils.js';
import { sweepStaleStoryWorktrees } from '../../.agents/scripts/lib/orchestration/plan-runner/worktree-sweep.js';
import {
  acquireSweepLock,
  resolveSweepLockPath,
} from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

/** Keep the closed-Story worktree sweep (and its lockfile) out of these cases. */
const NO_WORKTREE_SWEEP = {
  worktreeSweepFn: async () => ({ reaped: [], skipped: [] }),
  acquireLockFn: () => ({ acquired: true, release: () => {} }),
};

const CONFIG = {
  project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
  delivery: { worktreeIsolation: { sweepLockMs: 1234 } },
};

function makeProvider() {
  return { getTicket: async (id) => ({ id, state: 'closed', labels: [] }) };
}

function okEnvelope(extra = {}) {
  return {
    ok: true,
    skipped: false,
    candidates: 0,
    localDeleted: 0,
    remoteDeleted: 0,
    protected: [],
    failures: [],
    ...extra,
  };
}

describe('runBootSweep', () => {
  it('defaults the include glob to story-* and passes a protection ctx', async () => {
    let seen = null;
    await runBootSweep({
      cwd: '/tmp/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: (args) => {
        seen = args;
        return okEnvelope();
      },
    });
    assert.deepEqual(seen.include, ['story-*']);
    assert.equal(seen.baseBranch, 'main');
    assert.equal(seen.fastForward, true);
    assert.equal(typeof seen.protectionCtx.getTicket, 'function');
    assert.equal(typeof seen.protectionCtx.ghRunner, 'function');
    // runBootSweep resolves cwd via path.resolve, so the repoRoot it threads
    // into the protection ctx is the platform-absolute form ('/tmp/repo' on
    // POSIX, 'D:\\tmp\\repo' on Windows). Resolve the expected value the same
    // way so the assertion holds cross-platform (Windows Smoke).
    assert.equal(seen.protectionCtx.repoRoot, path.resolve('/tmp/repo'));
    // Story #5112 — the shared merged-branch sweep lock, not a boot-sweep
    // private one: `single-story-init.js` reaps the same branches through the
    // same engine and must contend with this run, not run alongside it.
    assert.equal(
      seen.lockPath,
      resolveSweepLockPath({
        cwd: path.resolve('/tmp/repo'),
        tempRoot: 'temp',
      }),
    );
    assert.equal(seen.lockTimeoutMs, 1234);
  });

  it('appends --current to the exclude set', async () => {
    let seen = null;
    await runBootSweep({
      cwd: '/tmp/repo',
      ...NO_WORKTREE_SWEEP,
      current: 'story-999',
      exclude: ['epic/*'],
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: (args) => {
        seen = args;
        return okEnvelope();
      },
    });
    assert.deepEqual(seen.exclude, ['epic/*', 'story-999']);
  });

  it('honours a custom include glob and --no-fast-forward', async () => {
    let seen = null;
    await runBootSweep({
      cwd: '/tmp/repo',
      ...NO_WORKTREE_SWEEP,
      include: ['feat/*'],
      fastForward: false,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: (args) => {
        seen = args;
        return okEnvelope();
      },
    });
    assert.deepEqual(seen.include, ['feat/*']);
    assert.equal(seen.fastForward, false);
  });

  it('swallows a sweep error and returns a skipped envelope (never throws)', async () => {
    const warns = [];
    const result = await runBootSweep({
      cwd: '/tmp/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      logger: { warn: (m) => warns.push(m) },
      injectedSweep: () => {
        throw new Error('lock contention');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error, /lock contention/);
    assert.equal(
      warns.some((w) => /sweep threw/.test(w)),
      true,
    );
    assert.deepEqual(result.contentMerged, []);
  });

  it('returns the engine envelope verbatim on success', async () => {
    const envelope = okEnvelope({ localDeleted: 3, remoteDeleted: 3 });
    const result = await runBootSweep({
      cwd: '/tmp/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: () => envelope,
    });
    assert.equal(result.localDeleted, 3);
    assert.equal(result.remoteDeleted, 3);
  });

  it('passes the content-merged partition through verbatim (report-only, Story #4396)', async () => {
    const envelope = okEnvelope({
      contentMerged: [{ branch: 'story-42', worktreePath: null }],
    });
    const result = await runBootSweep({
      cwd: '/tmp/repo',
      ...NO_WORKTREE_SWEEP,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: () => envelope,
    });
    assert.deepEqual(result.contentMerged, [
      { branch: 'story-42', worktreePath: null },
    ]);
  });
});

describe('buildSummaryLine (Story #4396)', () => {
  it('keeps the pre-Story #4396 line byte-identical on a zero contentMerged count', () => {
    const line = buildSummaryLine({
      localDeleted: 0,
      remoteDeleted: 0,
      protected: [],
      contentMerged: [],
    });
    assert.equal(line, '[boot-sweep] reaped 0 local + 0 remote; protected 0.');
  });

  it('omits the contentMerged clause when the field is absent entirely', () => {
    const line = buildSummaryLine({ localDeleted: 2, remoteDeleted: 2 });
    assert.equal(line, '[boot-sweep] reaped 2 local + 2 remote; protected 0.');
  });

  it('appends a routing hint with the count when contentMerged is nonzero', () => {
    const line = buildSummaryLine({
      localDeleted: 1,
      remoteDeleted: 1,
      protected: [],
      contentMerged: [
        { branch: 'story-42', worktreePath: null },
        { branch: 'story-43', worktreePath: null },
      ],
    });
    assert.equal(
      line,
      '[boot-sweep] reaped 1 local + 1 remote; protected 0; 2 content-merged branch(es) left for /git-cleanup.',
    );
  });
});

describe('boot-sweep — one lock with the init sweep (Story #5112)', () => {
  const tmpDirs = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      try {
        fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('reports skipped/lock-contended while an init sweep holds the lock', async () => {
    const root = makeTempDir('boot-sweep-lock-');
    tmpDirs.push(root);

    // Stand in for `single-story-init.js`'s in-flight merged-branch sweep: it
    // resolves the very same path through the shared helper.
    const held = acquireSweepLock({
      lockPath: resolveSweepLockPath({ cwd: root, tempRoot: 'temp' }),
      timeoutMs: 60_000,
      ownerId: 'init-sweep',
    });
    assert.equal(held.acquired, true);

    // No injectedSweep: the real engine runs, hits the lock and short-circuits
    // before it can touch git.
    const result = await runBootSweep({
      cwd: root,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      purgeFn: async () => ({ purged: [] }),
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'lock-contended');
    assert.equal(result.ok, true, 'contention never fails the host');
    assert.equal(result.localDeleted, 0);
    assert.equal(result.remoteDeleted, 0);
    assert.equal(
      result.worktreeSweep.reason,
      'lock-contended',
      'the worktree sweep contends on the same lock',
    );
    assert.deepEqual(result.worktreeSweep.reaped, []);

    held.release();
  });

  it('acquires and completes once the init sweep releases', async () => {
    const root = makeTempDir('boot-sweep-lock-');
    tmpDirs.push(root);
    const lockPath = resolveSweepLockPath({ cwd: root, tempRoot: 'temp' });

    const held = acquireSweepLock({ lockPath, ownerId: 'init-sweep' });
    assert.equal(held.acquired, true);
    held.release();

    let seenLockPath = null;
    const result = await runBootSweep({
      cwd: root,
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      purgeFn: async () => ({ purged: [] }),
      injectedSweep: (args) => {
        seenLockPath = args.lockPath;
        return okEnvelope();
      },
    });

    assert.equal(seenLockPath, lockPath);
    assert.equal(result.skipped, false);
  });
});

describe('boot-sweep — closed-Story worktree sweep (Story #5460)', () => {
  const tmpDirs = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      try {
        fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function addStoryWorktree(repo, id) {
    const wt = path.join(repo, '.worktrees', `story-${id}`);
    const res = gitSpawn(repo, 'worktree', 'add', '-b', `story-${id}`, wt);
    assert.equal(res.status, 0, res.stderr);
    return wt;
  }

  it('removes a closed Story worktree; keeps an open one and the running one', async () => {
    const repo = fs.realpathSync(makeGitRepo({ prefix: 'boot-wt-sweep-' }));
    tmpDirs.push(repo);
    const closed = addStoryWorktree(repo, 11);
    const open = addStoryWorktree(repo, 12);
    const running = addStoryWorktree(repo, 13);
    // Residue in a done Story's tree is noise, not work: it goes too.
    fs.writeFileSync(path.join(closed, 'residue.log'), 'x');

    const tickets = {
      11: { id: 11, state: 'closed', labels: ['agent::done'] },
      12: { id: 12, state: 'open', labels: ['agent::executing'] },
      13: { id: 13, state: 'closed', labels: ['agent::done'] },
    };
    const result = await runBootSweep({
      cwd: repo,
      injectedConfig: CONFIG,
      injectedProvider: { getTicket: async (id) => tickets[id] },
      injectedSweep: () => okEnvelope(),
      purgeFn: async () => ({ purged: [] }),
      logger: { info: () => {}, warn: () => {} },
      // Stand in for "this process was loaded from story-13".
      worktreeSweepFn: (args) =>
        sweepStaleStoryWorktrees({ ...args, runningPaths: [running] }),
    });

    assert.equal(result.worktreeSweep.ok, true);
    assert.deepEqual(
      result.worktreeSweep.reaped.map((r) => r.storyId),
      [11],
    );
    assert.equal(fs.existsSync(closed), false, 'closed Story tree removed');
    assert.equal(fs.existsSync(open), true, 'open Story tree kept');
    assert.equal(fs.existsSync(running), true, 'running tree kept');
    const reasons = Object.fromEntries(
      result.worktreeSweep.skipped.map((s) => [s.storyId, s.reason]),
    );
    assert.deepEqual(reasons, {
      12: 'story-open',
      13: 'running-from-target-tree',
    });
    const list = gitSpawn(repo, 'worktree', 'list', '--porcelain').stdout;
    assert.equal(list.includes('story-11'), false, 'registration pruned');
    assert.match(buildSummaryLine(result), /removed 1 closed-Story worktree/);
  });

  it('degrades a throwing worktree sweep into the envelope; boot never fails', async () => {
    const warns = [];
    const result = await runBootSweep({
      cwd: '/tmp/repo',
      injectedConfig: CONFIG,
      injectedProvider: makeProvider(),
      injectedSweep: () => okEnvelope({ localDeleted: 2 }),
      purgeFn: async () => ({ purged: [] }),
      acquireLockFn: () => ({ acquired: true, release: () => {} }),
      worktreeSweepFn: async () => {
        throw new Error('worktree list exploded');
      },
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    });
    assert.equal(result.ok, true, 'the branch sweep envelope survives');
    assert.equal(result.localDeleted, 2);
    assert.equal(result.worktreeSweep.ok, false);
    assert.match(result.worktreeSweep.error, /worktree list exploded/);
    assert.ok(warns.some((w) => /worktree sweep threw/.test(w)));
  });
});
