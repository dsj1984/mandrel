import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { provision as provisionWorkspace } from '../../.agents/scripts/lib/workspace-provisioner.js';
import {
  copyAgentsFromRoot,
  isAgentsSubmodule,
  removeCopiedAgents,
} from '../../.agents/scripts/lib/worktree/bootstrapper.js';
import {
  parseWorktreePorcelain,
  WorktreeManager,
} from '../../.agents/scripts/lib/worktree-manager.js';

// Strip every GIT_* env var so the integration tests' tmpdir cwd wins.
// When this suite runs inside a git hook (e.g. husky pre-push) the parent
// git invocation exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / etc.
// that override execFileSync's `cwd`, breaking fixture isolation.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

/**
 * Build a mock `git` object for WorktreeManager. `handlers` maps the
 * first two positional args joined by a space ("worktree add",
 * "status --porcelain", …) to a function `(cwd, args) => { status, stdout, stderr }`.
 */
function mockGit(handlers) {
  const calls = [];
  const dispatch = (cwd, args) => {
    calls.push({ cwd, args });
    const key2 = args.slice(0, 2).join(' ');
    const key1 = args[0];
    const fn = handlers[key2] ?? handlers[key1];
    if (!fn) return { status: 0, stdout: '', stderr: '' };
    return fn(cwd, args);
  };
  return {
    calls,
    gitSync: (cwd, ...args) => {
      const res = dispatch(cwd, args);
      if (res.status !== 0) throw new Error(res.stderr || 'git failed');
      return res.stdout;
    },
    gitSpawn: (cwd, ...args) => dispatch(cwd, args),
  };
}

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

test('parseWorktreePorcelain: parses multi-block porcelain output', () => {
  const raw = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/story-235',
    'HEAD def456',
    'branch refs/heads/story-235',
    '',
    'worktree /repo/.worktrees/bare',
    'bare',
  ].join('\n');
  const recs = parseWorktreePorcelain(raw);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].branch, 'main');
  assert.equal(recs[1].path, '/repo/.worktrees/story-235');
  assert.equal(recs[1].branch, 'story-235');
  assert.equal(recs[2].bare, true);
});

test('constructor: rejects root that escapes repoRoot', () => {
  assert.throws(
    () =>
      new WorktreeManager({
        repoRoot: '/repo',
        config: { root: '../../evil' },
        logger: SILENT_LOGGER,
        git: mockGit({}),
      }),
    /escapes repoRoot/,
  );
});

test('pathFor: resolves .worktrees/story-<id>/ and validates id', () => {
  const wm = new WorktreeManager({
    repoRoot: '/repo',
    logger: SILENT_LOGGER,
    git: mockGit({}),
    platform: 'linux',
  });
  assert.equal(
    wm.pathFor(235),
    path.resolve('/repo', '.worktrees', 'story-235'),
  );
  assert.throws(() => wm.pathFor('abc'), /invalid storyId/);
  assert.throws(() => wm.pathFor(-5), /invalid storyId/);
});

test('ensure: rejects branch not matching storyId', async () => {
  const wm = new WorktreeManager({
    repoRoot: '/repo',
    logger: SILENT_LOGGER,
    git: mockGit({}),
    platform: 'linux',
  });
  await assert.rejects(() => wm.ensure(235, 'story-999'), /does not match/);
  await assert.rejects(() => wm.ensure(235, 'main'), /must match/);
});

test('ensure: creates new branch + worktree when neither exists', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: 'worktree /repo\nHEAD x\nbranch refs/heads/main\n',
        stderr: '',
      }),
      'show-ref': () => ({ status: 1, stdout: '', stderr: '' }), // branch does not exist
      'worktree add': (_cwd, args) => {
        assert.deepEqual(args.slice(0, 4), [
          'worktree',
          'add',
          '-b',
          'story-235',
        ]);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const res = await wm.ensure(235, 'story-235');
    assert.equal(res.created, true);
    assert.equal(res.path, path.join(tmp, '.worktrees', 'story-235'));
    assert.ok(fs.existsSync(path.join(tmp, '.worktrees')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensure: idempotent when worktree already on correct branch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    const wtPath = path.join(tmp, '.worktrees', 'story-235');
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: `worktree ${wtPath}\nHEAD x\nbranch refs/heads/story-235\n`,
        stderr: '',
      }),
      'worktree add': () => {
        assert.fail(
          'ensure should not call `worktree add` for existing worktree',
        );
      },
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const res = await wm.ensure(235, 'story-235');
    assert.equal(res.created, false);
    assert.equal(res.path, wtPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensure: throws on branch mismatch at existing path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    const wtPath = path.join(tmp, '.worktrees', 'story-235');
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: `worktree ${wtPath}\nHEAD x\nbranch refs/heads/story-999\n`,
        stderr: '',
      }),
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    await assert.rejects(
      () => wm.ensure(235, 'story-235'),
      /on branch story-999/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isSafeToRemove: refuses on dirty tree', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const wtPath = path.join(tmp, 'dirty');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    const git = mockGit({
      'status --porcelain': () => ({
        status: 0,
        stdout: ' M file.js',
        stderr: '',
      }),
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.isSafeToRemove(wtPath);
    assert.equal(r.safe, false);
    assert.equal(r.reason, 'uncommitted-changes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isSafeToRemove: refuses when branch has unmerged commits vs epic', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const wtPath = path.join(tmp, 'clean');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    const git = mockGit({
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': (_cwd, args) => {
        if (args.includes('--abbrev-ref'))
          return { status: 0, stdout: 'story-235', stderr: '' };
        return { status: 0, stdout: 'TIP_SHA', stderr: '' };
      },
      // `merge-base --is-ancestor` exits 1 when branch is NOT an ancestor
      // of epicBranch — i.e. the branch has unmerged commits.
      'merge-base': () => ({ status: 1, stdout: '', stderr: '' }),
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.isSafeToRemove(wtPath, { epicBranch: 'epic/229' });
    assert.equal(r.safe, false);
    assert.equal(r.reason, 'unmerged-commits');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isSafeToRemove: refuses when merge verification errors unexpectedly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const wtPath = path.join(tmp, 'clean');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    const git = mockGit({
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': (_cwd, args) => {
        if (args.includes('--abbrev-ref'))
          return { status: 0, stdout: 'story-235', stderr: '' };
        return { status: 0, stdout: 'SHA', stderr: '' };
      },
      'merge-base': () => ({
        status: 128,
        stdout: '',
        stderr: 'fatal: Not a valid object name epic/229',
      }),
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.isSafeToRemove(wtPath, { epicBranch: 'epic/229' });
    assert.equal(r.safe, false);
    assert.match(r.reason, /merge-check-failed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isSafeToRemove: safe when clean and merged', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const wtPath = path.join(tmp, 'clean');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    const git = mockGit({
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': (_cwd, args) => {
        if (args.includes('--abbrev-ref'))
          return { status: 0, stdout: 'story-235', stderr: '' };
        return { status: 0, stdout: 'SAME_SHA', stderr: '' };
      },
      'show-ref': () => ({ status: 0, stdout: '', stderr: '' }),
      'merge-base': () => ({ status: 0, stdout: 'SAME_SHA', stderr: '' }),
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.isSafeToRemove(wtPath, { epicBranch: 'epic/229' });
    assert.equal(r.safe, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reap: throws on force=true', async () => {
  const wm = new WorktreeManager({
    repoRoot: '/repo',
    logger: SILENT_LOGGER,
    git: mockGit({}),
    platform: 'linux',
  });
  await assert.rejects(
    () => wm.reap(235, { force: true }),
    /--force is not permitted/,
  );
});

test('reap: returns not-a-worktree when path not registered', async () => {
  const git = mockGit({
    'worktree list': () => ({
      status: 0,
      stdout: 'worktree /repo\nHEAD x\nbranch refs/heads/main\n',
      stderr: '',
    }),
  });
  const wm = new WorktreeManager({
    repoRoot: '/repo',
    logger: SILENT_LOGGER,
    git,
    platform: 'linux',
  });
  const r = await wm.reap(235);
  assert.equal(r.removed, false);
  assert.equal(r.reason, 'not-a-worktree');
});

test('reap: skips unsafe worktree with warning', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const wtPath = path.join(tmp, '.worktrees', 'story-235');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: `worktree ${wtPath}\nHEAD x\nbranch refs/heads/story-235\n`,
        stderr: '',
      }),
      'status --porcelain': () => ({
        status: 0,
        stdout: ' M file',
        stderr: '',
      }),
      'worktree remove': () =>
        assert.fail('reap must not call remove on unsafe worktree'),
    });
    const warnings = [];
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: { info() {}, warn: (m) => warnings.push(m), error() {} },
      git,
      platform: 'linux',
    });
    const r = await wm.reap(235, {
      epicBranch: 'epic/229',
      discardAfterMerge: false,
    });
    assert.equal(r.removed, false);
    assert.equal(r.reason, 'uncommitted-changes');
    assert.ok(warnings.some((w) => /reap-skipped/.test(w)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reap: retries submodule-guard failure after generic gitlink scrub', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reap-submodule-'));
  const wtPath = path.join(tmp, '.worktrees', 'story-235');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    let removeCalls = 0;
    const rmPaths = [];
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: `worktree ${wtPath}\nHEAD x\nbranch refs/heads/story-235\n`,
        stderr: '',
      }),
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': () => ({ status: 0, stdout: 'story-235', stderr: '' }),
      'merge-base': () => ({ status: 0, stdout: '', stderr: '' }),
      'ls-files --stage': (_cwd, args) => {
        // Generic list call used by _dropAllSubmoduleGitlinksFromIndex.
        if (args.length === 2) {
          return {
            status: 0,
            stdout: '160000 abc123 0\tvendor/shared-submodule\n',
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      'update-index': () => ({ status: 0, stdout: '', stderr: '' }),
      rm: (_cwd, args) => {
        rmPaths.push(args[args.length - 1]);
        return { status: 0, stdout: '', stderr: '' };
      },
      'worktree remove': () => {
        removeCalls++;
        if (removeCalls === 1) {
          return {
            status: 1,
            stdout: '',
            stderr:
              'fatal: working trees containing submodules cannot be moved or removed',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.reap(235, { epicBranch: 'main' });
    assert.equal(r.removed, true, `reap failed: ${r.reason}`);
    assert.equal(removeCalls, 2, 'remove should retry after submodule guard');
    assert.ok(
      rmPaths.includes('vendor/shared-submodule'),
      'generic gitlink scrub should remove non-.agents submodules from index',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reap: retries lock-like remove failures on win32', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reap-lock-'));
  const wtPath = path.join(tmp, '.worktrees', 'story-235');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    let removeCalls = 0;
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: `worktree ${wtPath}\nHEAD x\nbranch refs/heads/story-235\n`,
        stderr: '',
      }),
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': () => ({ status: 0, stdout: 'story-235', stderr: '' }),
      'merge-base': () => ({ status: 0, stdout: '', stderr: '' }),
      'ls-files --stage': () => ({ status: 0, stdout: '', stderr: '' }),
      'worktree remove': () => {
        removeCalls++;
        if (removeCalls < 3) {
          return { status: 1, stdout: '', stderr: 'Permission denied' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'win32',
    });
    const r = await wm.reap(235, { epicBranch: 'main' });
    assert.equal(r.removed, true, `reap failed: ${r.reason}`);
    assert.equal(removeCalls, 3, 'remove should retry lock-like failures');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reap: treats prune-cleared registration as removed after repeated remove failures', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reap-prune-'));
  const wtPath = path.join(tmp, '.worktrees', 'story-235');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    let pruned = false;
    let removeCalls = 0;
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: pruned
          ? `worktree ${tmp}\nHEAD x\nbranch refs/heads/main\n`
          : `worktree ${tmp}\nHEAD x\nbranch refs/heads/main\n\nworktree ${wtPath}\nHEAD y\nbranch refs/heads/story-235\n`,
        stderr: '',
      }),
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': () => ({ status: 0, stdout: 'story-235', stderr: '' }),
      'merge-base': () => ({ status: 0, stdout: '', stderr: '' }),
      'ls-files --stage': () => ({ status: 0, stdout: '', stderr: '' }),
      'worktree remove': () => {
        removeCalls++;
        return { status: 1, stdout: '', stderr: 'Directory not empty' };
      },
      'worktree prune': () => {
        pruned = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.reap(235, { epicBranch: 'main' });
    assert.equal(
      r.removed,
      true,
      `reap should succeed once registration is prune-cleared: ${r.reason}`,
    );
    assert.equal(removeCalls, 2, 'linux path should attempt remove twice');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gc: reaps only worktrees for stories NOT in openStoryIds', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  try {
    const wt235 = path.join(tmp, '.worktrees', 'story-235');
    const wt236 = path.join(tmp, '.worktrees', 'story-236');
    fs.mkdirSync(wt235, { recursive: true });
    fs.mkdirSync(wt236, { recursive: true });
    const removed = [];
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: [
          `worktree ${tmp}`,
          'HEAD x',
          'branch refs/heads/main',
          '',
          `worktree ${wt235}`,
          'HEAD y',
          'branch refs/heads/story-235',
          '',
          `worktree ${wt236}`,
          'HEAD z',
          'branch refs/heads/story-236',
          '',
        ].join('\n'),
        stderr: '',
      }),
      'status --porcelain': () => ({ status: 0, stdout: '', stderr: '' }),
      'rev-parse': (cwd, args) => {
        if (args.includes('--abbrev-ref')) {
          const leaf = path.basename(cwd);
          return { status: 0, stdout: leaf, stderr: '' };
        }
        return { status: 0, stdout: 'SHA', stderr: '' };
      },
      'worktree remove': (_cwd, args) => {
        removed.push(args[2]);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.gc([235], { epicBranch: 'epic/229' }); // only 235 is still "open"
    assert.deepEqual(
      r.reaped.map((x) => x.storyId),
      [236],
    );
    assert.deepEqual(removed, [wt236]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reap: refuses managed story worktrees when epicBranch is omitted', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const wtPath = path.join(tmp, '.worktrees', 'story-235');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    const git = mockGit({
      'worktree list': () => ({
        status: 0,
        stdout: `worktree ${wtPath}\nHEAD x\nbranch refs/heads/story-235\n`,
        stderr: '',
      }),
    });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git,
      platform: 'linux',
    });
    const r = await wm.reap(235);
    assert.equal(r.removed, false);
    assert.equal(r.reason, 'epic-branch-required');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('prune: runs git worktree prune through WorktreeManager', () => {
  const git = mockGit({
    'worktree prune': () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const wm = new WorktreeManager({
    repoRoot: '/repo',
    logger: SILENT_LOGGER,
    git,
    platform: 'linux',
  });
  const r = wm.prune();
  assert.equal(r.pruned, true);
  assert.ok(
    git.calls.some(
      (call) => call.args[0] === 'worktree' && call.args[1] === 'prune',
    ),
  );
});

// ─────────────────── Integration test (real git) ───────────────────

test('integration: round-trips worktree add and remove on a real repo', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-int-'));
  const run = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });
  try {
    run(tmp, 'init', '-b', 'main');
    run(tmp, 'config', 'user.email', 'test@example.com');
    run(tmp, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
    run(tmp, 'add', '.');
    run(tmp, 'commit', '-m', 'init');

    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      platform: process.platform,
    });

    const ensured = await wm.ensure(42, 'story-42');
    assert.equal(ensured.created, true);
    assert.ok(fs.existsSync(ensured.path));

    const again = await wm.ensure(42, 'story-42');
    assert.equal(again.created, false, 'ensure must be idempotent');

    const list = await wm.list();
    assert.ok(list.some((r) => r.branch === 'story-42'));

    // Main branch fully contains story-42 (no new commits on story-42 yet).
    const reaped = await wm.reap(42, { epicBranch: 'main' });
    assert.equal(reaped.removed, true, `reap failed: ${reaped.reason}`);
    assert.equal(fs.existsSync(ensured.path), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// v5.11.5 regression: `_findByPath` used case-sensitive `===` on paths, so
// when the caller handed WorktreeManager a repoRoot with a different drive-
// letter case than git's porcelain output (common on Windows when a shell
// cwd uses `c:\...` while git stored `C:\...`), reap returned
// `not-a-worktree` silently and the worktree was never cleaned up. The
// integration test below is skipped off-win32 because only Windows exposes
// drive letters.
test('integration: reap() tolerates drive-letter-case mismatch on repoRoot (v5.11.5 regression)', {
  skip: process.platform !== 'win32',
}, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-case-'));
  const run = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });
  try {
    run(tmp, 'init', '-b', 'main');
    run(tmp, 'config', 'user.email', 'test@example.com');
    run(tmp, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
    run(tmp, 'add', '.');
    run(tmp, 'commit', '-m', 'init');

    // Create the worktree through a WorktreeManager whose repoRoot drive
    // letter matches git's native reporting (uppercase on Windows).
    const setup = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
    });
    const ensured = await setup.ensure(1337, 'story-1337');
    assert.equal(ensured.created, true);

    // Flip the drive letter on the repoRoot that close() will construct.
    // This mirrors a shell invoking story-close.js with `--cwd
    // c:\repo` while git still stores `C:\repo`.
    const driveLetter = tmp[0];
    const flipped =
      driveLetter === driveLetter.toUpperCase()
        ? driveLetter.toLowerCase() + tmp.slice(1)
        : driveLetter.toUpperCase() + tmp.slice(1);
    assert.notEqual(flipped, tmp, 'expected a different-case path');

    const wm = new WorktreeManager({
      repoRoot: flipped,
      logger: SILENT_LOGGER,
    });

    const reaped = await wm.reap(1337, { epicBranch: 'main' });
    assert.equal(
      reaped.removed,
      true,
      `reap returned ${reaped.reason} — drive-case mismatch regressed`,
    );
    assert.equal(fs.existsSync(ensured.path), false);

    const still = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: tmp,
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.ok(
      !/story-1337/.test(still),
      'worktree still registered after reap',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Windows long-path pre-flight warning
// ---------------------------------------------------------------------------

test('ensure: returns windowsPathWarning when estimated path exceeds threshold on win32', async () => {
  // Use a deep repoRoot so wtPath + 80-char allowance crosses the threshold.
  const deepRoot = `C:\\${'x'.repeat(180)}`;
  const warns = [];
  const git = mockGit({
    'worktree list': () => ({ status: 0, stdout: '', stderr: '' }),
    'show-ref': () => ({ status: 1, stdout: '', stderr: '' }),
    'worktree add': () => ({ status: 0, stdout: '', stderr: '' }),
    config: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const wm = new WorktreeManager({
    repoRoot: deepRoot,
    config: { windowsPathLengthWarnThreshold: 240 },
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    git,
    platform: 'win32',
  });
  // Skip the real mkdirSync — deepRoot does not exist on disk. Stub it.
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = () => undefined;
  try {
    const res = await wm.ensure(42, 'story-42');
    assert.ok(res.windowsPathWarning, 'warning payload must be present');
    assert.ok(res.windowsPathWarning.length > 240);
    assert.equal(res.windowsPathWarning.threshold, 240);
    assert.ok(warns.some((m) => /windows-long-path/.test(m)));
  } finally {
    fs.mkdirSync = originalMkdir;
  }
});

test('ensure: no windowsPathWarning when path is short', async () => {
  const git = mockGit({
    'worktree list': () => ({ status: 0, stdout: '', stderr: '' }),
    'show-ref': () => ({ status: 1, stdout: '', stderr: '' }),
    'worktree add': () => ({ status: 0, stdout: '', stderr: '' }),
    config: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const wm = new WorktreeManager({
    repoRoot: 'C:\\repo',
    logger: SILENT_LOGGER,
    git,
    platform: 'win32',
  });
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = () => undefined;
  try {
    const res = await wm.ensure(42, 'story-42');
    assert.equal(res.windowsPathWarning, undefined);
  } finally {
    fs.mkdirSync = originalMkdir;
  }
});

// ---------------------------------------------------------------------------
// nodeModulesStrategy — per-worktree / symlink / pnpm-store
// ---------------------------------------------------------------------------

function defaultStrategyGit() {
  return mockGit({
    'worktree list': () => ({ status: 0, stdout: '', stderr: '' }),
    'show-ref': () => ({ status: 1, stdout: '', stderr: '' }),
    'worktree add': (_cwd, args) => {
      // Create the worktree directory so _applyNodeModulesStrategy can find it.
      const wtPath = args[args.length - 1];
      fs.mkdirSync(wtPath, { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    },
    config: () => ({ status: 0, stdout: '', stderr: '' }),
  });
}

test('nodeModulesStrategy: per-worktree is a no-op (default)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: {}, // default strategy
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'linux',
    });
    const res = await wm.ensure(100, 'story-100');
    assert.equal(fs.existsSync(path.join(res.path, 'node_modules')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: pnpm-store is a no-op (agent runs pnpm install)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: { nodeModulesStrategy: 'pnpm-store' },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'linux',
    });
    const res = await wm.ensure(101, 'story-101');
    assert.equal(fs.existsSync(path.join(res.path, 'node_modules')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: symlink creates link from primed donor', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    // Prime a donor worktree-like directory with node_modules.
    const prime = path.join(tmp, 'prime');
    fs.mkdirSync(path.join(prime, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(prime, 'node_modules', 'pkg', 'index.js'), '//');

    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: {
        nodeModulesStrategy: 'symlink',
        primeFromPath: 'prime',
      },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'linux',
    });

    const res = await wm.ensure(102, 'story-102');
    const nm = path.join(res.path, 'node_modules');
    assert.ok(fs.existsSync(nm), 'symlink should exist');
    // Symlink target resolves to the primed node_modules.
    assert.ok(fs.existsSync(path.join(nm, 'pkg', 'index.js')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: symlink without primeFromPath throws', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: { nodeModulesStrategy: 'symlink' },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'linux',
    });
    await assert.rejects(
      () => wm.ensure(103, 'story-103'),
      /requires orchestration\.worktreeIsolation\.primeFromPath/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: symlink with missing primed node_modules throws', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    // primeFromPath exists but has no node_modules dir.
    fs.mkdirSync(path.join(tmp, 'empty-prime'), { recursive: true });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: {
        nodeModulesStrategy: 'symlink',
        primeFromPath: 'empty-prime',
      },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'linux',
    });
    await assert.rejects(
      () => wm.ensure(104, 'story-104'),
      /no node_modules directory/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: symlink refuses on Windows without explicit opt-in', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    fs.mkdirSync(path.join(tmp, 'prime', 'node_modules'), { recursive: true });
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: {
        nodeModulesStrategy: 'symlink',
        primeFromPath: 'prime',
      },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'win32',
    });
    await assert.rejects(
      () => wm.ensure(105, 'story-105'),
      /refuses on Windows/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: symlink uses junction on Windows when opted in', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  const originalSymlinkSync = fs.symlinkSync;
  const calls = [];
  try {
    fs.mkdirSync(path.join(tmp, 'prime', 'node_modules'), { recursive: true });
    fs.symlinkSync = (...args) => {
      calls.push(args);
    };
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: {
        nodeModulesStrategy: 'symlink',
        primeFromPath: 'prime',
        allowSymlinkOnWindows: true,
      },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'win32',
    });
    await wm.ensure(105, 'story-105');
    assert.equal(calls.length, 1);
    const expectedLinkType = process.platform === 'win32' ? 'junction' : 'dir';
    assert.equal(calls[0][2], expectedLinkType);
  } finally {
    fs.symlinkSync = originalSymlinkSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nodeModulesStrategy: unknown value throws (defense-in-depth vs schema)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-strat-'));
  try {
    const wm = new WorktreeManager({
      repoRoot: tmp,
      config: { nodeModulesStrategy: 'bogus' },
      logger: SILENT_LOGGER,
      git: defaultStrategyGit(),
      platform: 'linux',
    });
    await assert.rejects(
      () => wm.ensure(106, 'story-106'),
      /unknown nodeModulesStrategy 'bogus'/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provisionWorkspace: default copies .env when present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-'));
  try {
    fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://x\n');
    fs.writeFileSync(path.join(tmp, '.mcp.json'), '{"servers":{}}\n');
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });

    provisionWorkspace({
      sourceRoot: tmp,
      targetWorktree: wtPath,
      files: ['.env'],
      logger: SILENT_LOGGER,
    });

    assert.equal(
      fs.readFileSync(path.join(wtPath, '.env'), 'utf-8'),
      'DATABASE_URL=postgres://x\n',
    );
    assert.equal(fs.existsSync(path.join(wtPath, '.mcp.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provisionWorkspace: no-op when source .env does not exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-'));
  try {
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });

    provisionWorkspace({
      sourceRoot: tmp,
      targetWorktree: wtPath,
      files: ['.env'],
      logger: SILENT_LOGGER,
    });

    assert.equal(fs.existsSync(path.join(wtPath, '.env')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provisionWorkspace: never overwrites an existing worktree .env', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-'));
  try {
    fs.writeFileSync(path.join(tmp, '.env'), 'ROOT=1\n');
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, '.env'), 'AGENT_OVERRIDE=1\n');

    provisionWorkspace({
      sourceRoot: tmp,
      targetWorktree: wtPath,
      files: ['.env'],
      logger: SILENT_LOGGER,
    });

    assert.equal(
      fs.readFileSync(path.join(wtPath, '.env'), 'utf-8'),
      'AGENT_OVERRIDE=1\n',
      'agent-placed .env must survive',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provisionWorkspace: rejects path traversal and absolute paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-'));
  try {
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });

    const warns = [];
    provisionWorkspace({
      sourceRoot: tmp,
      targetWorktree: wtPath,
      files: ['../../etc/passwd', '/abs/path', '.env'],
      logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    });

    assert.equal(
      warns.filter((m) => m.includes('skipped invalid')).length,
      2,
      'both traversal and absolute paths should be rejected',
    );
    // Legitimate `.env` in the list should still have been attempted (no
    // source file here, so it's a silent no-op — no warning).
    assert.equal(fs.existsSync(path.join(wtPath, '.env')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('provisionWorkspace: honors configured workspace files list', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-'));
  try {
    fs.writeFileSync(path.join(tmp, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(tmp, '.env.test'), 'B=2\n');
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });

    provisionWorkspace({
      sourceRoot: tmp,
      targetWorktree: wtPath,
      files: ['.env', '.env.test'],
      logger: SILENT_LOGGER,
    });

    assert.equal(fs.existsSync(path.join(wtPath, '.env')), true);
    assert.equal(fs.existsSync(path.join(wtPath, '.env.test')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyAgentsFromRoot: refuses to wipe root .agents when wtPath equals repoRoot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-safety-'));
  try {
    const rootAgents = path.join(tmp, '.agents');
    fs.mkdirSync(rootAgents);
    fs.writeFileSync(path.join(rootAgents, 'sentinel.txt'), 'precious');

    // Force submodule-mode via the ctx bag so `copyAgentsFromRoot` actually
    // runs its body even though the fixture has no `.gitmodules`.
    const ctx = {
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      git: mockGit({}),
      platform: 'linux',
      isAgentsSubmodule: () => true,
    };

    assert.throws(
      () => copyAgentsFromRoot(ctx, tmp),
      /refusing to clear root \.agents/,
    );
    assert.equal(
      fs.existsSync(path.join(rootAgents, 'sentinel.txt')),
      true,
      'root .agents must not be touched when wtPath aliases repoRoot',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyAgentsFromRoot: recursively copies root .agents into the worktree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-copy-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.gitmodules'),
      '[submodule ".agents"]\n\tpath = .agents\n\turl = ../agents\n',
    );
    const rootAgents = path.join(tmp, '.agents');
    fs.mkdirSync(path.join(rootAgents, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(rootAgents, 'VERSION'), 'v1\n');
    fs.writeFileSync(
      path.join(rootAgents, 'workflows', 'story-execute.md'),
      '# run\n',
    );

    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    const wtAgents = path.join(wtPath, '.agents');
    // Simulate the empty gitlink placeholder `git worktree add` leaves.
    fs.mkdirSync(wtAgents, { recursive: true });

    const git = mockGit({
      'ls-files --stage': () => ({
        status: 0,
        stdout: '160000 abc123 0\t.agents\n',
        stderr: '',
      }),
      'update-index': () => ({ status: 0, stdout: '', stderr: '' }),
    });
    copyAgentsFromRoot(
      { repoRoot: tmp, logger: SILENT_LOGGER, git, platform: 'linux' },
      wtPath,
    );

    assert.equal(
      fs.readFileSync(path.join(wtAgents, 'VERSION'), 'utf8'),
      'v1\n',
    );
    assert.equal(
      fs.readFileSync(
        path.join(wtAgents, 'workflows', 'story-execute.md'),
        'utf8',
      ),
      '# run\n',
    );
    assert.equal(
      fs.lstatSync(wtAgents).isSymbolicLink(),
      false,
      'copied .agents must be a real directory, not a symlink',
    );
    const skipCall = git.calls.find(
      (c) => c.args[0] === 'update-index' && c.args.includes('--skip-worktree'),
    );
    assert.ok(
      skipCall,
      'copy path should mark .agents gitlink as skip-worktree',
    );
    const rmCachedCall = git.calls.find(
      (c) => c.args[0] === 'rm' && c.args.includes('--cached'),
    );
    assert.equal(
      rmCachedCall,
      undefined,
      'copy path must not stage gitlink deletion',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isAgentsSubmodule: accepts quoted .agents path entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gitmodules-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.gitmodules'),
      '[submodule ".agents"]\n\tpath = ".agents"\n\turl = ../agents\n',
    );
    assert.equal(isAgentsSubmodule(tmp), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeCopiedAgents: removes the copied directory and scrubs the index gitlink', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-copy-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.gitmodules'),
      '[submodule ".agents"]\n\tpath = .agents\n\turl = ../agents\n',
    );
    const rootAgents = path.join(tmp, '.agents');
    fs.mkdirSync(rootAgents);
    fs.writeFileSync(path.join(rootAgents, 'sentinel.txt'), 'precious');

    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    const wtAgents = path.join(wtPath, '.agents');
    fs.mkdirSync(wtAgents, { recursive: true });
    fs.writeFileSync(path.join(wtAgents, 'copied.txt'), 'copy');

    const calls = [];
    const git = {
      gitSync: () => '',
      gitSpawn: (cwd, ...args) => {
        calls.push({ cwd, args });
        const key2 = args.slice(0, 2).join(' ');
        if (key2 === 'ls-files --stage') {
          return {
            status: 0,
            stdout: '160000 abc123 0\t.agents\n',
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    removeCopiedAgents(
      { repoRoot: tmp, logger: SILENT_LOGGER, git, platform: 'linux' },
      wtPath,
    );

    assert.equal(
      fs.existsSync(wtAgents),
      false,
      'copied .agents directory must be removed',
    );
    assert.equal(
      fs.existsSync(path.join(rootAgents, 'sentinel.txt')),
      true,
      'root .agents must be untouched',
    );
    const rmCall = calls.find(
      (c) => c.args[0] === 'rm' && c.args.includes('.agents'),
    );
    assert.ok(rmCall, 'git rm --cached must scrub the gitlink');
    assert.equal(rmCall.cwd, wtPath);
    const noSkipCall = calls.find(
      (c) =>
        c.args[0] === 'update-index' && c.args.includes('--no-skip-worktree'),
    );
    assert.ok(
      noSkipCall,
      'reap path should clear skip-worktree before index scrub',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeCopiedAgents: unlinks legacy symlinks without traversing into the target', () => {
  // Worktrees created under the old symlink scheme may still be live when
  // the copy-based code ships. `removeCopiedAgents` must detect the symlink
  // and unlink it rather than rmSync-ing through it. The legacy scheme
  // only existed in submodule-consumer repos, so `.gitmodules` is part of
  // the fixture.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-legacy-symlink-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.gitmodules'),
      '[submodule ".agents"]\n\tpath = .agents\n\turl = ../agents\n',
    );
    const rootAgents = path.join(tmp, '.agents');
    fs.mkdirSync(rootAgents);
    fs.writeFileSync(path.join(rootAgents, 'sentinel.txt'), 'precious');

    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });
    const wtAgents = path.join(wtPath, '.agents');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(rootAgents, wtAgents, linkType);

    removeCopiedAgents(
      {
        repoRoot: tmp,
        logger: SILENT_LOGGER,
        git: mockGit({}),
        platform: process.platform === 'win32' ? 'win32' : 'linux',
      },
      wtPath,
    );

    assert.equal(fs.existsSync(wtAgents), false, 'symlink should be removed');
    assert.equal(
      fs.existsSync(path.join(rootAgents, 'sentinel.txt')),
      true,
      'symlink target must not be traversed during removal',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeCopiedAgents: purges per-worktree modules/ dir so submodule guard passes', () => {
  // git refuses `worktree remove` when <gitdir>/modules/ exists even if the
  // per-worktree index has no 160000 gitlink. Reap must scrub both.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-modules-purge-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.gitmodules'),
      '[submodule ".agents"]\n\tpath = .agents\n\turl = ../agents\n',
    );
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });
    const perWtGitdir = path.join(tmp, '.git', 'worktrees', 'story-1');
    const modulesDir = path.join(perWtGitdir, 'modules', '.agents');
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.writeFileSync(path.join(modulesDir, 'HEAD'), 'ref: refs/heads/main\n');
    // Worktree's .git is a file pointing at the per-worktree gitdir.
    fs.writeFileSync(path.join(wtPath, '.git'), `gitdir: ${perWtGitdir}\n`);

    removeCopiedAgents(
      {
        repoRoot: tmp,
        logger: SILENT_LOGGER,
        git: mockGit({}),
        platform: 'linux',
      },
      wtPath,
    );

    assert.equal(
      fs.existsSync(path.join(perWtGitdir, 'modules')),
      false,
      'per-worktree modules/ dir must be purged before git worktree remove',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeCopiedAgents: refuses to purge a gitdir outside the main repos .git/worktrees', () => {
  // If the `gitdir:` pointer is malformed or points elsewhere, we must NOT
  // recursively delete that directory.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-modules-guard-'));
  try {
    fs.writeFileSync(
      path.join(tmp, '.gitmodules'),
      '[submodule ".agents"]\n\tpath = .agents\n\turl = ../agents\n',
    );
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });
    // Evil: gitdir points to a sibling directory outside `.git/worktrees/`.
    const evilGitdir = path.join(tmp, 'evil-gitdir');
    fs.mkdirSync(path.join(evilGitdir, 'modules'), { recursive: true });
    fs.writeFileSync(
      path.join(evilGitdir, 'modules', 'sentinel.txt'),
      'must survive',
    );
    fs.writeFileSync(path.join(wtPath, '.git'), `gitdir: ${evilGitdir}\n`);

    removeCopiedAgents(
      {
        repoRoot: tmp,
        logger: SILENT_LOGGER,
        git: mockGit({}),
        platform: 'linux',
      },
      wtPath,
    );

    assert.equal(
      fs.existsSync(path.join(evilGitdir, 'modules', 'sentinel.txt')),
      true,
      'out-of-bounds gitdir must not have its modules/ purged',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeCopiedAgents: skips index scrub AND preserves tracked .agents in non-submodule (framework) repos', () => {
  // See ADR-20260424-638a: the physical-delete branch must also be guarded,
  // otherwise `.agents/` (a tracked directory in framework repos) is wiped
  // immediately before `git worktree remove`, leaving the worktree dirty
  // and forcing the reap path into the fs-rm-retry tail.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-framework-'));
  try {
    // No .gitmodules → isAgentsSubmodule() returns false.
    const wtPath = path.join(tmp, '.worktrees', 'story-1');
    const wtAgents = path.join(wtPath, '.agents');
    fs.mkdirSync(wtAgents, { recursive: true });
    fs.writeFileSync(path.join(wtAgents, 'sentinel.txt'), 'tracked content');

    const calls = [];
    const git = {
      gitSync: () => '',
      gitSpawn: (_cwd, ...args) => {
        calls.push(args[0]);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    removeCopiedAgents(
      { repoRoot: tmp, logger: SILENT_LOGGER, git, platform: 'linux' },
      wtPath,
    );
    assert.equal(
      calls.includes('ls-files'),
      false,
      'framework repos must not probe the index',
    );
    assert.equal(calls.includes('rm'), false);
    assert.equal(
      fs.existsSync(wtAgents),
      true,
      'tracked .agents must survive reap in framework repos',
    );
    assert.equal(
      fs.readFileSync(path.join(wtAgents, 'sentinel.txt'), 'utf8'),
      'tracked content',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensure: never warns on non-win32 even with very long paths', async () => {
  const deepRoot = `/${'x'.repeat(300)}`;
  const warns = [];
  const git = mockGit({
    'worktree list': () => ({ status: 0, stdout: '', stderr: '' }),
    'show-ref': () => ({ status: 1, stdout: '', stderr: '' }),
    'worktree add': () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const wm = new WorktreeManager({
    repoRoot: deepRoot,
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    git,
    platform: 'linux',
  });
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = () => undefined;
  try {
    const res = await wm.ensure(42, 'story-42');
    assert.equal(res.windowsPathWarning, undefined);
    assert.equal(warns.length, 0);
  } finally {
    fs.mkdirSync = originalMkdir;
  }
});
