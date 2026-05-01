/**
 * Epic #413 Phase 4 replay regression test.
 *
 * Reproduces the conditions recorded in `feedback_sprint_story_close_reap.md`:
 * 6 worktrees whose Story branches are already merged into `epic/413`, with 3
 * of them carrying post-merge drift (biome format churn, stray sub-agent
 * edits) that left them dirty. Prior to this fix, Phase 4 reaped only the 3
 * clean worktrees; the new `--reap-discard-after-merge` default should reap
 * all 6 and surface the discarded paths.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorktreeManager } from '../.agents/scripts/lib/worktree-manager.js';

const EPIC_ID = 413;
const EPIC_BRANCH = `epic/${EPIC_ID}`;
const STORY_IDS = [420, 421, 422, 423, 424, 425];
const DIRTY_STORY_IDS = new Set([420, 423, 424]);
const DIRTY_PORCELAIN = ' M .agents/scripts/lib/foo.js\n?? scratch.txt';

function buildReplayGit(_repoRoot, worktreeRoot) {
  const calls = [];
  const worktreeListStdout = STORY_IDS.map(
    (id) =>
      `worktree ${path.join(worktreeRoot, `story-${id}`)}\nHEAD abc\nbranch refs/heads/story-${id}\n`,
  ).join('\n');

  function storyIdFromCwd(cwd) {
    const m = String(cwd).match(/story-(\d+)$/);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  const dispatch = (cwd, args) => {
    calls.push({ cwd, args: args.slice() });
    const key2 = args.slice(0, 2).join(' ');
    const key3 = args.slice(0, 3).join(' ');

    if (key2 === 'worktree list') {
      return { status: 0, stdout: worktreeListStdout, stderr: '' };
    }
    if (key2 === 'status --porcelain') {
      const id = storyIdFromCwd(cwd);
      if (id !== null && DIRTY_STORY_IDS.has(id)) {
        return { status: 0, stdout: DIRTY_PORCELAIN, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
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
      if (fs.existsSync(target))
        fs.rmSync(target, { recursive: true, force: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (key2 === 'worktree prune') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
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

test('epic-413 phase-4 replay: reap-discard-after-merge reaps all 6 worktrees', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-413-replay-'));
  const worktreeRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  for (const id of STORY_IDS) {
    fs.mkdirSync(path.join(worktreeRoot, `story-${id}`), { recursive: true });
  }

  try {
    const git = buildReplayGit(tmp, worktreeRoot);
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: { info() {}, warn() {}, error() {} },
      git,
      platform: 'linux',
    });

    const result = await wm.gc([], { epicBranch: EPIC_BRANCH });

    assert.equal(
      result.reaped.length,
      STORY_IDS.length,
      `expected all ${STORY_IDS.length} worktrees reaped, got ${result.reaped.length} (skipped: ${JSON.stringify(result.skipped)})`,
    );
    assert.equal(result.skipped.length, 0, 'no worktrees should be skipped');

    const dirtyReaped = result.reaped.filter((r) =>
      DIRTY_STORY_IDS.has(r.storyId),
    );
    assert.equal(
      dirtyReaped.length,
      DIRTY_STORY_IDS.size,
      'every dirty worktree should appear in reaped[]',
    );
    for (const entry of dirtyReaped) {
      assert.ok(
        Array.isArray(entry.discardedPaths) && entry.discardedPaths.length > 0,
        `dirty story-${entry.storyId} must surface discardedPaths, got ${JSON.stringify(entry.discardedPaths)}`,
      );
    }

    const cleanReaped = result.reaped.filter(
      (r) => !DIRTY_STORY_IDS.has(r.storyId),
    );
    for (const entry of cleanReaped) {
      assert.equal(
        entry.discardedPaths,
        undefined,
        `clean story-${entry.storyId} must not carry discardedPaths`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('epic-413 phase-4 replay: --no-reap-discard-after-merge preserves skip on dirty worktrees', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-413-replay-noflag-'));
  const worktreeRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  for (const id of STORY_IDS) {
    fs.mkdirSync(path.join(worktreeRoot, `story-${id}`), { recursive: true });
  }

  try {
    const git = buildReplayGit(tmp, worktreeRoot);
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: { info() {}, warn() {}, error() {} },
      git,
      platform: 'linux',
    });

    const result = await wm.gc([], {
      epicBranch: EPIC_BRANCH,
      discardAfterMerge: false,
    });

    const cleanCount = STORY_IDS.length - DIRTY_STORY_IDS.size;
    assert.equal(result.reaped.length, cleanCount);
    assert.equal(result.skipped.length, DIRTY_STORY_IDS.size);
    for (const s of result.skipped) {
      assert.equal(s.reason, 'uncommitted-changes');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
