import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __setGitRunners } from '../.agents/scripts/lib/git-utils.js';
import { WorktreeManager } from '../.agents/scripts/lib/worktree-manager.js';
import { runStoryClose } from '../.agents/scripts/story-close.js';
import { runStoryInit } from '../.agents/scripts/story-init.js';
import { MockProvider } from './fixtures/mock-provider.js';

const gitHistory = [];
let currentBranch = 'main';

const trackBranch = (args) => {
  if (args.includes('checkout')) {
    const idx = args.indexOf('checkout');
    let branch = args[idx + 1];
    if (branch === '-b' || branch === '-B' || branch === '-t') {
      branch = args[idx + 2];
    }
    if (branch && !branch.startsWith('-')) currentBranch = branch;
  }
};

const mockExec = (cmd, args) => {
  gitHistory.push({ cmd, args, type: 'exec' });
  trackBranch(args);
  if (args.includes('ls-remote')) return 'abc story-100';
  return '';
};
// Tracks branches known to exist locally so rev-parse --verify behaves
// realistically in bootstrap tri-state decisions.
const knownLocalBranches = new Set(['main']);
const knownRemoteBranches = new Set();

const mockSpawn = (cmd, args) => {
  gitHistory.push({ cmd, args, type: 'spawn' });
  // Register new branches from `checkout -b <name>` BEFORE trackBranch runs,
  // so subsequent rev-parse calls see them.
  if (args[0] === 'checkout') {
    const flagIdx = args.findIndex((a) => a === '-b' || a === '-B');
    if (flagIdx >= 0 && args[flagIdx + 1]) {
      knownLocalBranches.add(args[flagIdx + 1]);
    }
  }
  if (args[0] === 'push') {
    const branch = args[args.length - 1];
    if (branch && !branch.startsWith('-')) knownRemoteBranches.add(branch);
  }
  trackBranch(args);
  if (args.includes('--show-current')) {
    return { status: 0, stdout: currentBranch, stderr: '' };
  }
  if (args[0] === 'rev-parse' && args.includes('--verify')) {
    const ref = args[args.length - 1];
    const branch = ref.replace(/^refs\/heads\//, '');
    return {
      status: knownLocalBranches.has(branch) ? 0 : 128,
      stdout: '',
      stderr: '',
    };
  }
  if (args[0] === 'ls-remote') {
    const branch = args[args.length - 1];
    return {
      status: 0,
      stdout: knownRemoteBranches.has(branch)
        ? `abc\trefs/heads/${branch}`
        : '',
      stderr: '',
    };
  }
  if (args[0] === 'status' && args.includes('--porcelain')) {
    return { status: 0, stdout: '', stderr: '' };
  }
  return { status: 0, stdout: '', stderr: '' };
};

__setGitRunners(mockExec, mockSpawn);

test.beforeEach(() => {
  gitHistory.length = 0;
  currentBranch = 'main';
  knownLocalBranches.clear();
  knownLocalBranches.add('main');
  knownRemoteBranches.clear();
});

const mockConfig = {
  agentSettings: { mainBranch: 'main' },
  orchestration: {
    provider: 'github',
    // Webhook safety: these tests invoke runStoryInit without a sandboxed cwd,
    // so Notifier would otherwise resolve the real webhook URL from the
    // project's `.mcp.json`. Disabling the level keeps POSTs from firing.
    notifications: { level: 'off' },
  },
};

test('story-init: successful initialization', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50\nPRD: #51',
        labels: ['type::story'],
      },
      50: { id: 50, title: 'Epic 50', labels: ['type::epic'] },
      101: {
        id: 101,
        title: 'Task 1',
        body: 'parent: #100',
        labels: ['type::task', 'agent::ready'],
      },
      102: {
        id: 102,
        title: 'Task 2',
        body: 'parent: #100\nblocked by #101',
        labels: ['type::task', 'agent::ready'],
      },
    },
    subTickets: {
      100: [101, 102],
    },
  });

  const { success, result } = await runStoryInit({
    storyId: 100,
    dryRun: false,
    injectedProvider: provider,
    injectedConfig: mockConfig,
  });

  assert.ok(success, 'Should succeed');
  assert.equal(result.tasks.length, 2, 'Should find 2 tasks');
  assert.equal(
    result.tasks[0].id,
    101,
    'Task 1 should be first (dependency order)',
  );
  assert.equal(result.tasks[1].id, 102, 'Task 2 should be second');

  // Verify ticket updates
  const task1Updates = provider.updates.filter((u) => u.id === 101);
  assert.ok(
    task1Updates.some((u) =>
      u.mutations.labels.add.includes('agent::executing'),
    ),
    'Task 1 should be executing',
  );

  // Verify git actions
  const pullCalls = gitHistory.filter((h) => h.args.includes('pull'));
  assert.ok(pullCalls.length > 0, 'Should attempt git pull');
});

test('story-init: fails on open blockers', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50\nblocked by #99',
        labels: ['type::story'],
      },
      50: { id: 50, title: 'Epic 50', labels: ['type::epic'] },
      99: {
        id: 99,
        title: 'Prereq',
        labels: ['agent::executing'],
        state: 'open',
      },
    },
  });

  const { success, blocked, openBlockers } = await runStoryInit({
    storyId: 100,
    dryRun: false,
    injectedProvider: provider,
    injectedConfig: mockConfig,
  });

  assert.strictEqual(success, false, 'Should fail');
  assert.strictEqual(blocked, true, 'Should be flagged as blocked');
  assert.strictEqual(openBlockers.length, 1, 'Should find 1 open blocker');
  assert.strictEqual(openBlockers[0].id, 99);
});

test('story-init: fails closed when blocker verification errors', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50\nblocked by #99',
        labels: ['type::story'],
      },
      50: { id: 50, title: 'Epic 50', labels: ['type::epic'] },
    },
  });
  provider.getTicket = async (id) => {
    if (id === 99) throw new Error('GitHub API timeout');
    if (!provider.tickets[id])
      throw new Error(`Ticket #${id} not found in mock`);
    return JSON.parse(JSON.stringify(provider.tickets[id]));
  };

  const { success, blocked, openBlockers } = await runStoryInit({
    storyId: 100,
    dryRun: false,
    injectedProvider: provider,
    injectedConfig: mockConfig,
  });

  assert.strictEqual(
    success,
    false,
    'Should fail when blocker state is unknown',
  );
  assert.strictEqual(
    blocked,
    true,
    'Unknown blocker verification should block',
  );
  assert.strictEqual(
    openBlockers.length,
    1,
    'Should surface the unverified blocker',
  );
  assert.strictEqual(openBlockers[0].id, 99);
  assert.equal(openBlockers[0].fetchError, true);
});

test('story-init: epic exists locally only → pushes to remote (no crash)', async () => {
  // Reproduces the #329 crash: epic/50 exists locally from a prior partial
  // run but not remotely. Old logic ran `checkout -b epic/50` and failed.
  knownLocalBranches.add('epic/50');

  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50',
        labels: ['type::story'],
      },
      50: { id: 50, title: 'Epic 50', labels: ['type::epic'] },
    },
    subTickets: { 100: [] },
  });

  const { success } = await runStoryInit({
    storyId: 100,
    dryRun: false,
    injectedProvider: provider,
    injectedConfig: mockConfig,
  });

  assert.ok(success, 'Should succeed when epic exists locally only');
  const checkoutCreateCalls = gitHistory.filter(
    (h) =>
      h.args[0] === 'checkout' &&
      (h.args[1] === '-b' || h.args[1] === '-B') &&
      h.args[2] === 'epic/50',
  );
  assert.strictEqual(
    checkoutCreateCalls.length,
    0,
    'Must not attempt `checkout -b epic/50` when branch already exists locally',
  );
  const pushCalls = gitHistory.filter(
    (h) => h.args[0] === 'push' && h.args.includes('epic/50'),
  );
  assert.ok(pushCalls.length > 0, 'Should publish the local-only epic branch');
});

test('story-init: refuses to switch branches when working tree is dirty', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50',
        labels: ['type::story'],
      },
      50: { id: 50, title: 'Epic 50', labels: ['type::epic'] },
    },
    subTickets: { 100: [] },
  });

  // Temporarily inject a dirty-tree response for `status --porcelain`.
  __setGitRunners(mockExec, (cmd, args) => {
    if (args[0] === 'status' && args.includes('--porcelain')) {
      return {
        status: 0,
        stdout: ' M apps/api/src/routes/v1/media/highlights.ts',
        stderr: '',
      };
    }
    return mockSpawn(cmd, args);
  });

  await assert.rejects(
    runStoryInit({
      storyId: 100,
      dryRun: false,
      injectedProvider: provider,
      injectedConfig: mockConfig,
    }),
    /Working tree is dirty/,
  );

  // Restore
  __setGitRunners(mockExec, mockSpawn);
});

test('story-close: successful merge and closure', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50',
        labels: ['type::story', 'agent::executing'],
      },
      101: {
        id: 101,
        title: 'Task 1',
        body: 'parent: #100',
        labels: ['type::task', 'agent::executing'],
      },
    },
    subTickets: {
      100: [101],
    },
  });

  // Use a disposable sandbox as the repo root so the epic-merge-lock's
  // `fs.mkdirSync(<cwd>/.git, { recursive: true })` can succeed. When the
  // test runs inside a `.worktrees/` checkout the default PROJECT_ROOT
  // points at a worktree whose `.git` is a gitlink *file*, which makes the
  // recursive mkdir throw EEXIST and masks the real merge outcome.
  const sandboxCwd = fs.mkdtempSync(
    path.join(os.tmpdir(), 'story-close-merge-'),
  );
  fs.writeFileSync(
    path.join(sandboxCwd, '.agentrc.json'),
    JSON.stringify({
      agentSettings: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      orchestration: {
        provider: 'github',
        github: { owner: 'o', repo: 'r' },
        worktreeIsolation: { enabled: false },
      },
    }),
  );
  const originalReap = WorktreeManager.prototype.reap;
  WorktreeManager.prototype.reap = async function (_storyId) {
    return {
      removed: false,
      reason: 'not-a-worktree',
      path: this.pathFor(100),
    };
  };
  try {
    const { success, result } = await runStoryClose({
      storyId: 100,
      cwd: sandboxCwd,
      injectedProvider: provider,
      skipValidation: true,
    });

    assert.ok(success, 'Should succeed');
    assert.strictEqual(result.merged, true, 'Should be marked as merged');

    // Verify closures
    const story = provider.tickets[100];
    const task = provider.tickets[101];
    assert.ok(story.labels.includes('agent::done'), 'Story should be done');
    assert.ok(task.labels.includes('agent::done'), 'Task should be done');
  } finally {
    WorktreeManager.prototype.reap = originalReap;
    fs.rmSync(sandboxCwd, { recursive: true, force: true });
  }
});

test('story-close: reaps worktree using resolved --cwd repo root', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50',
        labels: ['type::story', 'agent::executing'],
      },
    },
    subTickets: {
      100: [],
    },
  });
  const explicitMainRepo = fs.mkdtempSync(
    path.join(os.tmpdir(), 'close-cwd-reap-'),
  );
  fs.writeFileSync(
    path.join(explicitMainRepo, '.agentrc.json'),
    JSON.stringify({
      agentSettings: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      orchestration: {
        provider: 'github',
        github: { owner: 'o', repo: 'r' },
        worktreeIsolation: {
          enabled: true,
          root: '.worktrees',
          reapOnSuccess: true,
        },
      },
    }),
  );
  let observedRepoRoot = null;
  const originalReap = WorktreeManager.prototype.reap;
  WorktreeManager.prototype.reap = async function (_storyId, _opts) {
    observedRepoRoot = this.repoRoot;
    return {
      removed: false,
      reason: 'not-a-worktree',
      path: this.pathFor(100),
    };
  };
  try {
    const { success } = await runStoryClose({
      storyId: 100,
      cwd: explicitMainRepo,
      injectedProvider: provider,
      skipValidation: true,
    });
    assert.ok(success, 'Story close should still succeed');
    assert.equal(
      observedRepoRoot,
      explicitMainRepo,
      'WorktreeManager must be rooted at the runtime --cwd path',
    );
  } finally {
    WorktreeManager.prototype.reap = originalReap;
    fs.rmSync(explicitMainRepo, { recursive: true, force: true });
  }
});

test('story-close: resolves config from runtime --cwd (can disable reap)', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50',
        labels: ['type::story', 'agent::executing'],
      },
    },
    subTickets: {
      100: [],
    },
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'close-cwd-config-'));
  fs.writeFileSync(
    path.join(tmp, '.agentrc.json'),
    JSON.stringify({
      agentSettings: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      orchestration: {
        provider: 'github',
        github: { owner: 'o', repo: 'r' },
        worktreeIsolation: { enabled: false },
      },
    }),
  );

  let reapCalls = 0;
  const originalReap = WorktreeManager.prototype.reap;
  WorktreeManager.prototype.reap = async function (_storyId, _opts) {
    reapCalls++;
    return { removed: true, path: this.pathFor(100) };
  };

  try {
    const { success } = await runStoryClose({
      storyId: 100,
      cwd: tmp,
      injectedProvider: provider,
      skipValidation: true,
    });
    assert.ok(success, 'Story close should still succeed');
    assert.equal(
      reapCalls,
      0,
      'With worktreeIsolation.enabled=false in runtime cwd config, reap must be skipped',
    );
  } finally {
    WorktreeManager.prototype.reap = originalReap;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('story-init: resolves config from runtime --cwd for worktree mode', async () => {
  const provider = new MockProvider({
    tickets: {
      100: {
        id: 100,
        title: 'Story 100',
        body: 'Epic: #50',
        labels: ['type::story'],
      },
      50: { id: 50, title: 'Epic 50', labels: ['type::epic'] },
    },
    subTickets: {
      100: [],
    },
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cwd-config-'));
  fs.writeFileSync(
    path.join(tmp, '.agentrc.json'),
    JSON.stringify({
      agentSettings: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      orchestration: {
        provider: 'github',
        github: { owner: 'o', repo: 'r' },
        worktreeIsolation: { enabled: false },
      },
    }),
  );

  let ensureCalls = 0;
  const originalEnsure = WorktreeManager.prototype.ensure;
  WorktreeManager.prototype.ensure = async function (_storyId, _branch) {
    ensureCalls++;
    return { path: this.pathFor(100), created: true };
  };

  try {
    const { success } = await runStoryInit({
      storyId: 100,
      dryRun: false,
      cwd: tmp,
      injectedProvider: provider,
    });
    assert.ok(success, 'Story init should still succeed');
    assert.equal(
      ensureCalls,
      0,
      'With worktreeIsolation.enabled=false in runtime cwd config, init must not ensure worktree',
    );
  } finally {
    WorktreeManager.prototype.ensure = originalEnsure;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
