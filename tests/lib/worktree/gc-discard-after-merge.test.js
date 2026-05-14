import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorktreeManager } from '../../../.agents/scripts/lib/worktree-manager.js';

const EPIC_BRANCH = 'epic/999001';
const STORY_IDS = [999101, 999102, 999103, 999104];
const DIRTY_STORY_IDS = new Set([999101, 999103]);
const DIRTY_PORCELAIN = ' M .agents/scripts/lib/foo.js\n?? scratch.txt';

function buildGcGit(worktreeRoot) {
  const worktreeListStdout = STORY_IDS.map(
    (id) =>
      `worktree ${path.join(worktreeRoot, `story-${id}`)}\nHEAD abc\nbranch refs/heads/story-${id}\n`,
  ).join('\n');

  function storyIdFromCwd(cwd) {
    const m = String(cwd).match(/story-(\d+)$/);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  function dispatch(cwd, args) {
    const key2 = args.slice(0, 2).join(' ');
    const key3 = args.slice(0, 3).join(' ');

    if (key2 === 'worktree list') {
      return { status: 0, stdout: worktreeListStdout, stderr: '' };
    }
    if (key2 === 'status --porcelain') {
      const id = storyIdFromCwd(cwd);
      return {
        status: 0,
        stdout: id !== null && DIRTY_STORY_IDS.has(id) ? DIRTY_PORCELAIN : '',
        stderr: '',
      };
    }
    if (key3 === 'rev-parse --abbrev-ref') {
      const id = storyIdFromCwd(cwd);
      return { status: 0, stdout: id ? `story-${id}` : 'HEAD', stderr: '' };
    }
    if (key3 === 'merge-base --is-ancestor') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'reset' || args[0] === 'clean') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (key2 === 'worktree remove') {
      const target = args[2];
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (key2 === 'worktree prune') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }

  return {
    gitSync: (cwd, ...args) => {
      const res = dispatch(cwd, args);
      if (res.status !== 0) throw new Error(res.stderr || 'git failed');
      return res.stdout;
    },
    gitSpawn: (cwd, ...args) => dispatch(cwd, args),
  };
}

function makeManager(tmp, worktreeRoot) {
  return new WorktreeManager({
    repoRoot: tmp,
    logger: { info() {}, warn() {}, error() {} },
    git: buildGcGit(worktreeRoot),
    platform: 'linux',
  });
}

function makeWorktreeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-discard-after-merge-'));
  const worktreeRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  for (const id of STORY_IDS) {
    fs.mkdirSync(path.join(worktreeRoot, `story-${id}`), { recursive: true });
  }
  return { tmp, worktreeRoot };
}

test('gc reaps dirty worktrees after their story branches are merged into the epic', async () => {
  const { tmp, worktreeRoot } = makeWorktreeFixture();

  try {
    const wm = makeManager(tmp, worktreeRoot);
    const result = await wm.gc([], { epicBranch: EPIC_BRANCH });

    assert.equal(result.reaped.length, STORY_IDS.length);
    assert.equal(result.skipped.length, 0);

    const dirtyReaped = result.reaped.filter((r) =>
      DIRTY_STORY_IDS.has(r.storyId),
    );
    assert.equal(dirtyReaped.length, DIRTY_STORY_IDS.size);
    for (const entry of dirtyReaped) {
      assert.ok(
        Array.isArray(entry.discardedPaths) && entry.discardedPaths.length > 0,
        `dirty story-${entry.storyId} must surface discardedPaths`,
      );
    }

    const cleanReaped = result.reaped.filter(
      (r) => !DIRTY_STORY_IDS.has(r.storyId),
    );
    for (const entry of cleanReaped) {
      assert.equal(entry.discardedPaths, undefined);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gc preserves skip-on-dirty behavior when discard-after-merge is disabled', async () => {
  const { tmp, worktreeRoot } = makeWorktreeFixture();

  try {
    const wm = makeManager(tmp, worktreeRoot);
    const result = await wm.gc([], {
      epicBranch: EPIC_BRANCH,
      discardAfterMerge: false,
    });

    const cleanCount = STORY_IDS.length - DIRTY_STORY_IDS.size;
    assert.equal(result.reaped.length, cleanCount);
    assert.equal(result.skipped.length, DIRTY_STORY_IDS.size);
    for (const skipped of result.skipped) {
      assert.equal(skipped.reason, 'uncommitted-changes');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
