// tests/scripts/single-story-init-worktree-sweep.test.js — Story #5461.
//
// `single-story-init.js` never reaches `runBootSweep`, so its boot runs the
// closed-Story worktree sweep through the same seam (`runWorktreeSweep`):
// same lock, same invariants, plus the Story being initialized is always
// kept. Every case runs against a throwaway fixture repo — never the real
// checkout, whose `.worktrees/` belongs to other sessions.
//
// Run: node --test tests/scripts/single-story-init-worktree-sweep.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { FetchCache } from '../../.agents/scripts/lib/git/cached-fetch.js';
import { gitSpawn } from '../../.agents/scripts/lib/git-utils.js';
import {
  materializeBaseBranch,
  reapClosedStoryWorktrees,
  reapMergedStoryBranches,
} from '../../.agents/scripts/single-story-init.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

const CONFIG = {
  project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
};

const noopBranchSweep = async () => ({});

const tickets = {
  31: { id: 31, state: 'closed', labels: ['agent::done'] },
  32: { id: 32, state: 'open', labels: ['agent::executing'] },
  // The Story being initialized — closed here on purpose, so only the
  // running-tree guard init hands the sweep (never its ticket state)
  // can protect it.
  33: { id: 33, state: 'closed', labels: ['agent::done'] },
};
const provider = { getTicket: async (id) => tickets[id] };

describe('single-story-init — closed-Story worktree sweep (Story #5461)', () => {
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

  function fixtureRepo() {
    const repo = fs.realpathSync.native(
      makeGitRepo({ prefix: 'init-wt-sweep-' }),
    );
    tmpDirs.push(repo);
    const trees = {};
    for (const id of [31, 32, 33]) {
      const wt = path.join(repo, '.worktrees', `story-${id}`);
      const res = gitSpawn(repo, 'worktree', 'add', '-b', `story-${id}`, wt);
      assert.equal(res.status, 0, res.stderr);
      trees[id] = wt;
    }
    return { repo, trees };
  }

  function assertSwept(outcome, trees, repo) {
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      outcome.reaped.map((r) => r.storyId),
      [31],
    );
    assert.equal(fs.existsSync(trees[31]), false, 'closed Story tree removed');
    assert.equal(fs.existsSync(trees[32]), true, 'open Story tree kept');
    assert.equal(fs.existsSync(trees[33]), true, 'initializing Story kept');
    const reasons = Object.fromEntries(
      outcome.skipped.map((s) => [s.storyId, s.reason]),
    );
    assert.deepEqual(reasons, {
      32: 'story-open',
      33: 'running-from-target-tree',
    });
    const list = gitSpawn(repo, 'worktree', 'list', '--porcelain').stdout;
    assert.equal(list.includes('story-31'), false, 'registration pruned');
  }

  it('the init reap removes a closed Story tree, keeping the open one and its own', async () => {
    const { repo, trees } = fixtureRepo();
    const { worktreeSweep } = await reapMergedStoryBranches({
      cwd: repo,
      baseBranch: 'main',
      storyBranch: 'story-33',
      config: CONFIG,
      provider,
      injectedSweep: noopBranchSweep,
    });
    assertSwept(worktreeSweep, trees, repo);
  });

  it('materializeBaseBranch carries the sweep outcome back for the init envelope', async () => {
    const { repo, trees } = fixtureRepo();
    // A warm fetch cache keeps the fixture (which has no remote) off the network.
    const fetchCache = new FetchCache({ now: () => 0 });
    fetchCache.recordFetch(repo, 'origin');
    const out = await materializeBaseBranch({
      cwd: repo,
      baseBranch: 'main',
      storyBranch: 'story-33',
      config: CONFIG,
      provider,
      injectedSweep: noopBranchSweep,
      progress: () => {},
      fetchCache,
    });
    assertSwept(out.worktreeSweep, trees, repo);
  });

  it('a contended sweep lock skips the sweep and removes nothing', async () => {
    const { repo, trees } = fixtureRepo();
    const outcome = await reapClosedStoryWorktrees({
      cwd: repo,
      storyBranch: 'story-33',
      provider,
      lockPath: path.join(repo, 'temp', 'sweep.lock'),
      lockTimeoutMs: 60_000,
      acquireLockFn: () => ({ acquired: false, reason: 'contended' }),
    });
    assert.equal(outcome.reason, 'lock-contended');
    assert.deepEqual(outcome.reaped, []);
    for (const wt of Object.values(trees))
      assert.equal(fs.existsSync(wt), true);
  });

  it('degrades a throwing sweep into the outcome; init never fails', async () => {
    const outcome = await reapClosedStoryWorktrees({
      cwd: '/nonexistent-repo',
      storyBranch: 'story-33',
      provider,
      lockPath: '/nonexistent-repo/temp/sweep.lock',
      lockTimeoutMs: 60_000,
      acquireLockFn: () => ({ acquired: true, release: () => {} }),
      worktreeSweepFn: async () => {
        throw new Error('worktree list exploded');
      },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /worktree list exploded/);
    assert.deepEqual(outcome.reaped, []);
  });
});
