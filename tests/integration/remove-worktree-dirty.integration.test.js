// tests/integration/remove-worktree-dirty.integration.test.js
/**
 * Real-git round trip for git-cleanup's destructive wrappers. A linked
 * worktree holding an untracked file refuses a plain `git worktree remove`,
 * so only the `--force` escalation inside the real `removeWorktree` (as production binds it in `git-probes.js`) can
 * remove it — if that branch is deleted this test fails with `ok: false`.
 * The same fixture drives the real `dropStash` and the default
 * fast-forward probes (`defaultFfProbes`) through the real `gitSpawn` binding.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  dropStash,
  removeWorktree,
} from '../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes.js';
import { defaultFfProbes } from '../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes-ff.js';
import { makeGitRepo, seedGitIdentity } from '../fixtures/git-fixture.js';

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: CLEAN_ENV,
  });
}

describe('removeWorktree — real dirty linked worktree', () => {
  let repo;
  let worktree;

  beforeEach(() => {
    repo = makeGitRepo({ prefix: 'rm-wt-dirty-' });
    seedGitIdentity(repo);
    worktree = path.join(repo, '.worktrees', 'story-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'story-1', worktree);
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'dirty\n');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('escalates to --force, reports dirty:true and removes the directory', () => {
    const res = removeWorktree(worktree, repo);

    assert.equal(res.ok, true, `expected force removal, got ${res.stderr}`);
    assert.equal(res.dirty, true);
    assert.equal(fs.existsSync(worktree), false);
    assert.doesNotMatch(git(repo, 'worktree', 'list'), /story-1/);
  });

  it('removes a clean linked worktree without forcing', () => {
    fs.rmSync(path.join(worktree, 'untracked.txt'));

    assert.deepEqual(removeWorktree(worktree, repo), {
      ok: true,
      dirty: false,
    });
    assert.equal(fs.existsSync(worktree), false);
  });
});

describe('git-probes-ff default bindings — real repo', () => {
  let repo;

  beforeEach(() => {
    repo = makeGitRepo({ prefix: 'ff-probes-real-' });
    seedGitIdentity(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('drops a real stash and reports a missing one', () => {
    fs.writeFileSync(path.join(repo, 'baseline.json'), '{"floor":41}\n');
    git(repo, 'stash', 'push', '-q');
    assert.equal(defaultFfProbes.isClean(repo), true);

    assert.deepEqual(dropStash('stash@{0}', repo), { ok: true });
    assert.equal(git(repo, 'stash', 'list').trim(), '');
    assert.equal(dropStash('stash@{0}', repo).ok, false);
  });

  it('checks out, fast-forwards and probes against a real ref', () => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
    git(repo, 'add', 'extra.txt');
    git(repo, 'commit', '-q', '-m', 'extra');

    assert.equal(defaultFfProbes.checkout(repo, 'main').ok, true);
    assert.deepEqual(defaultFfProbes.merge(repo, 'feature'), { ok: true });
    assert.equal(fs.existsSync(path.join(repo, 'extra.txt')), true);
    assert.equal(defaultFfProbes.checkout(repo, 'no-such-branch').ok, false);
    assert.equal(
      defaultFfProbes.fetch(repo, 'no-such-remote', 'main').ok,
      false,
    );
    assert.deepEqual(
      defaultFfProbes.canFastForward(repo, 'main', 'no-such-remote'),
      {
        ok: false,
        behind: 0,
        reason: 'rev-list-failed',
      },
    );

    fs.writeFileSync(path.join(repo, 'extra.txt'), 'changed\n');
    assert.equal(defaultFfProbes.isClean(repo), false);
  });
});
