/**
 * tests/scripts/single-story-init-seed-provision.test.js — Story #5685
 *
 * `single-story-init.js` left the coverage exclusion list, so its exported
 * guards and git-mutating seams are driven here directly: the Story
 * deliverability guard, the missing-dependency refusal, the idempotent
 * `story-<id>` seed and single-tree provisioning — the last two against a
 * throwaway real repository.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  assertDeliverableStory,
  provisionWorktree,
  runSingleStoryInit,
  seedStoryBranch,
} from '../../.agents/scripts/single-story-init.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: CLEAN_ENV,
  }).trim();
}

function recorder() {
  const calls = [];
  const fn = (phase, msg) => calls.push([phase, msg]);
  fn.calls = calls;
  return fn;
}

describe('assertDeliverableStory', () => {
  const story = (over = {}) => ({
    labels: ['type::story'],
    state: 'open',
    body: '## Goal\nship it',
    ...over,
  });

  it('accepts an open type::story with no Epic footer', () => {
    assert.doesNotThrow(() => assertDeliverableStory(story(), 1));
  });

  it('accepts a Story with a non-string body', () => {
    assert.doesNotThrow(() => assertDeliverableStory(story({ body: null }), 1));
  });

  it('refuses a ticket that is not a Story', () => {
    assert.throws(
      () => assertDeliverableStory(story({ labels: ['type::epic'] }), 9),
      /Issue #9 is not a Story \(labels: type::epic\)/,
    );
  });

  it('refuses a closed Story', () => {
    assert.throws(
      () => assertDeliverableStory(story({ state: 'closed' }), 9),
      /Story #9 is already closed/,
    );
  });

  it('refuses a Story still declaring an Epic/Parent footer', () => {
    assert.throws(
      () => assertDeliverableStory(story({ body: 'Parent: #12' }), 9),
      /still declares an Epic\/Parent footer/,
    );
  });
});

describe('runSingleStoryInit — dependency guard', () => {
  it('refuses with an install hint when node_modules is missing', async () => {
    const empty = makeTempDir('ssi-no-deps-');
    try {
      await assert.rejects(
        runSingleStoryInit({ storyId: 5685, cwd: empty }),
        /Project dependencies are not installed.*Run `npm install`/,
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('seedStoryBranch / provisionWorktree — real repository', () => {
  let repo;

  beforeEach(() => {
    repo = makeGitRepo({ prefix: 'ssi-seed-' });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('creates story-<id> from the base branch, then reuses it on re-run', () => {
    const progress = recorder();

    seedStoryBranch({
      cwd: repo,
      storyBranch: 'story-7',
      baseBranch: 'main',
      progress,
    });
    seedStoryBranch({
      cwd: repo,
      storyBranch: 'story-7',
      baseBranch: 'main',
      progress,
    });

    assert.equal(
      git(repo, 'rev-parse', 'story-7'),
      git(repo, 'rev-parse', 'main'),
    );
    assert.deepEqual(
      progress.calls.map(([, msg]) => msg),
      [
        'Creating story branch ref: story-7 from main',
        'Reusing existing local story branch: story-7',
      ],
    );
  });

  it('fails loudly when the base ref does not exist', () => {
    assert.throws(
      () =>
        seedStoryBranch({
          cwd: repo,
          storyBranch: 'story-8',
          baseBranch: 'no-such-base',
          progress: () => {},
        }),
      /Failed to create story branch story-8/,
    );
  });

  it('checks the branch out in place when worktree isolation is off', async () => {
    git(repo, 'branch', 'story-9');

    const res = await provisionWorktree({
      runtime: { worktreeEnabled: false },
      cwd: repo,
      storyId: 9,
      storyBranch: 'story-9',
      config: {},
      progress: () => {},
    });

    assert.deepEqual(res, {
      workCwd: repo,
      worktreeCreated: false,
      installStatus: { status: 'skipped', reason: 'single-tree-mode' },
    });
    assert.equal(git(repo, 'branch', '--show-current'), 'story-9');
  });
});
