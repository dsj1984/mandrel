import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sweepStaleStoryWorktrees } from '../../../../.agents/scripts/lib/orchestration/plan-runner/worktree-sweep.js';
import {
  manifestPath,
  readManifest,
  recordPendingCleanup,
} from '../../../../.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js';
import { MockProvider } from '../../../fixtures/mock-provider.js';

const REPO = '/repo';

function porcelain(paths) {
  return paths
    .map((p, i) =>
      [
        `worktree ${p}`,
        `HEAD abc${i}`,
        `branch refs/heads/${p.split(/[\\/]/).pop()}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function makeFakeGit({ listStdout, removeResponses = {} }) {
  const calls = [];
  return {
    calls,
    gitSpawn: (_cwd, ...args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: listStdout, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const path = args[args.length - 1];
        const resp = removeResponses[path] ?? {
          status: 0,
          stdout: '',
          stderr: '',
        };
        return resp;
      }
      if (args[0] === 'worktree' && args[1] === 'prune') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

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

test('sweepStaleStoryWorktrees: force-removes worktrees for agent::done stories', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'S100',
        labels: ['type::story', 'agent::done'],
        state: 'closed',
      },
      200: {
        id: 200,
        title: 'S200',
        labels: ['type::story', 'agent::executing'],
        state: 'open',
      },
    },
  });
  const listStdout = porcelain([
    '/repo/.worktrees/story-100',
    '/repo/.worktrees/story-200',
  ]);
  const git = makeFakeGit({ listStdout });
  const { logger } = quietLogger();

  const result = await sweepStaleStoryWorktrees({
    provider,
    repoRoot: REPO,
    git,
    logger,
  });

  assert.equal(result.reaped.length, 1);
  assert.equal(result.reaped[0].storyId, 100);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].storyId, 200);
  assert.equal(result.skipped[0].reason, 'story-open');

  const removeCalls = git.calls.filter(
    (a) => a[0] === 'worktree' && a[1] === 'remove',
  );
  assert.equal(removeCalls.length, 1);
  assert.ok(removeCalls[0].includes('--force'));
  assert.ok(removeCalls[0].includes('/repo/.worktrees/story-100'));
});

test('sweepStaleStoryWorktrees: reaps closed (state=closed, no agent::done label) stories', async () => {
  const provider = new MockProvider({
    tickets: {
      300: { id: 300, title: 'S300', labels: ['type::story'], state: 'closed' },
    },
  });
  const git = makeFakeGit({
    listStdout: porcelain(['/repo/.worktrees/story-300']),
  });
  const { logger } = quietLogger();

  const result = await sweepStaleStoryWorktrees({
    provider,
    repoRoot: REPO,
    git,
    logger,
  });

  assert.equal(result.reaped.length, 1);
  assert.equal(result.reaped[0].storyId, 300);
});

test('sweepStaleStoryWorktrees: leaves non-story worktrees alone', async () => {
  const provider = new MockProvider({ tickets: {} });
  const git = makeFakeGit({
    listStdout: porcelain(['/repo', '/repo/.worktrees/hotfix-42']),
  });
  const { logger } = quietLogger();

  const result = await sweepStaleStoryWorktrees({
    provider,
    repoRoot: REPO,
    git,
    logger,
  });

  assert.equal(result.reaped.length, 0);
  assert.equal(result.skipped.length, 0);
  const removeCalls = git.calls.filter(
    (a) => a[0] === 'worktree' && a[1] === 'remove',
  );
  assert.equal(removeCalls.length, 0);
});

test('sweepStaleStoryWorktrees: skips when provider.getTicket throws and logs the reason', async () => {
  const provider = new MockProvider({ tickets: {} });
  provider.getTicket = async () => {
    throw new Error('network boom');
  };
  const git = makeFakeGit({
    listStdout: porcelain(['/repo/.worktrees/story-999']),
  });
  const { logger, sink } = quietLogger();

  const result = await sweepStaleStoryWorktrees({
    provider,
    repoRoot: REPO,
    git,
    logger,
  });

  assert.equal(result.reaped.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /provider-error: network boom/);
  assert.ok(sink.warn.some((m) => m.includes('network boom')));
});

test('sweepStaleStoryWorktrees: surfaces remove failures in skipped, keeps going', async () => {
  const provider = new MockProvider({
    tickets: {
      500: {
        id: 500,
        title: 'S500',
        labels: ['type::story', 'agent::done'],
        state: 'closed',
      },
      501: {
        id: 501,
        title: 'S501',
        labels: ['type::story', 'agent::done'],
        state: 'closed',
      },
    },
  });
  const git = makeFakeGit({
    listStdout: porcelain([
      '/repo/.worktrees/story-500',
      '/repo/.worktrees/story-501',
    ]),
    removeResponses: {
      '/repo/.worktrees/story-500': {
        status: 1,
        stdout: '',
        stderr: 'sharing violation',
      },
    },
  });
  const { logger } = quietLogger();

  const result = await sweepStaleStoryWorktrees({
    provider,
    repoRoot: REPO,
    git,
    logger,
  });

  assert.equal(result.reaped.length, 1);
  assert.equal(result.reaped[0].storyId, 501);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].storyId, 500);
  assert.match(result.skipped[0].reason, /sharing violation/);
});

test('sweepStaleStoryWorktrees: returns empty result when git worktree list fails', async () => {
  const provider = new MockProvider({ tickets: {} });
  const calls = [];
  const git = {
    calls,
    gitSpawn: (_cwd, ...args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 128, stdout: '', stderr: 'not a git repo' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const { logger, sink } = quietLogger();

  const result = await sweepStaleStoryWorktrees({
    provider,
    repoRoot: REPO,
    git,
    logger,
  });

  assert.deepEqual(result, { reaped: [], skipped: [] });
  assert.ok(sink.warn.some((m) => m.includes('git worktree list failed')));
});

test('sweepStaleStoryWorktrees: throws when provider is missing', async () => {
  await assert.rejects(
    () => sweepStaleStoryWorktrees({ repoRoot: REPO }),
    /provider with getTicket/,
  );
});

test('sweepStaleStoryWorktrees: throws when repoRoot is missing', async () => {
  await assert.rejects(
    () =>
      sweepStaleStoryWorktrees({ provider: new MockProvider({ tickets: {} }) }),
    /repoRoot is required/,
  );
});

test('sweepStaleStoryWorktrees: drains the pending-cleanup manifest when Stage 1 retry succeeds', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-drain-'));
  const wtRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  try {
    recordPendingCleanup(wtRoot, {
      storyId: 808,
      branch: 'story-808',
      path: path.join(wtRoot, 'story-808'),
      push: false,
    });

    const provider = new MockProvider({ tickets: {} });
    const git = makeFakeGit({ listStdout: porcelain([tmp]) });
    const { logger } = quietLogger();

    const result = await sweepStaleStoryWorktrees({
      provider,
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: async () => {
        // Lock cleared — fs.rm now succeeds.
      },
      logger,
    });

    assert.deepEqual(result.drainedPending, [808]);
    assert.deepEqual(result.persistentPending, []);
    assert.deepEqual(result.stillPending, []);
    assert.equal(fs.existsSync(manifestPath(wtRoot)), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sweepStaleStoryWorktrees: keeps stuck manifest entry and logs persistent-lock after MAX_SWEEP_ATTEMPTS', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-stuck-'));
  const wtRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(wtRoot, { recursive: true });
  try {
    recordPendingCleanup(wtRoot, {
      storyId: 909,
      branch: 'story-909',
      path: path.join(wtRoot, 'story-909'),
      push: false,
    });
    fs.mkdirSync(path.join(wtRoot, 'story-909'), { recursive: true });
    // Simulate two prior sweep failures already on disk.
    const manifest = readManifest(wtRoot);
    manifest[0].attempts = 2;
    fs.writeFileSync(
      manifestPath(wtRoot),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const provider = new MockProvider({ tickets: {} });
    const git = makeFakeGit({ listStdout: porcelain([tmp]) });
    const { logger, sink } = quietLogger();

    const result = await sweepStaleStoryWorktrees({
      provider,
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      git,
      fsRm: async () => {
        const err = new Error('EBUSY: still locked');
        err.code = 'EBUSY';
        throw err;
      },
      logger,
    });

    assert.deepEqual(result.drainedPending, []);
    assert.deepEqual(result.persistentPending, [909]);
    assert.ok(
      sink.error.some((m) => m.includes('persistent-lock')),
      'expected OPERATOR ACTION REQUIRED: persistent-lock log',
    );
    const post = readManifest(wtRoot);
    assert.equal(post.length, 1);
    assert.equal(post[0].attempts, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
