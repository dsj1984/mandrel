import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkDirtyTree,
  checkTicketNotDone,
  checkUnpushedWork,
  evaluateProtection,
  isTicketDone,
  storyIdFromBranch,
} from '../../.agents/scripts/lib/single-story-sweep/protection.js';

function makeGit({ revParse = {}, status = {} } = {}) {
  return (cwd, ...args) => {
    if (args[0] === 'rev-parse') {
      const ref = args[1];
      if (revParse[ref] === undefined) {
        return { status: 1, stderr: `unknown ref ${ref}`, stdout: '' };
      }
      return { status: 0, stdout: `${revParse[ref]}\n`, stderr: '' };
    }
    if (args[0] === 'status' && args[1] === '--porcelain') {
      const key = cwd;
      if (status[key] === undefined) {
        return { status: 1, stderr: 'not a worktree', stdout: '' };
      }
      return { status: 0, stdout: status[key], stderr: '' };
    }
    return { status: 1, stderr: 'unknown args', stdout: '' };
  };
}

function makeGh(viewByPr) {
  return (args /*, _opts */) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      const prNumber = Number.parseInt(args[2], 10);
      const data = viewByPr[prNumber];
      if (!data) throw new Error(`pr-view-no-data-for #${prNumber}`);
      if (data.error) throw new Error(data.error);
      return JSON.stringify({ headRefOid: data.headRefOid });
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  };
}

describe('storyIdFromBranch', () => {
  it('extracts the numeric id from story-<n>', () => {
    assert.equal(storyIdFromBranch('story-42'), 42);
    assert.equal(storyIdFromBranch('story-1981'), 1981);
  });

  it('returns null for non-story shapes', () => {
    assert.equal(storyIdFromBranch('epic/100'), null);
    assert.equal(storyIdFromBranch('feature/foo'), null);
    assert.equal(storyIdFromBranch(null), null);
    assert.equal(storyIdFromBranch(undefined), null);
  });
});

describe('isTicketDone', () => {
  it('treats closed-state tickets as done', () => {
    assert.equal(isTicketDone({ state: 'closed', labels: [] }), true);
  });

  it('treats agent::done-labeled tickets as done even when open', () => {
    assert.equal(
      isTicketDone({ state: 'open', labels: ['agent::done', 'type::story'] }),
      true,
    );
  });

  it('open tickets without the done label are not done', () => {
    assert.equal(
      isTicketDone({ state: 'open', labels: ['agent::executing'] }),
      false,
    );
  });

  it('null / missing ticket counts as not done', () => {
    assert.equal(isTicketDone(null), false);
    assert.equal(isTicketDone(undefined), false);
  });
});

describe('checkUnpushedWork', () => {
  it('does NOT protect when branch HEAD matches the PR headRefOid', () => {
    const result = checkUnpushedWork({
      candidate: { branch: 'story-100', prNumber: 200 },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({ revParse: { 'story-100': 'abc' } }),
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
      },
    });
    assert.deepEqual(result, { protected: false });
  });

  it('PROTECTS when branch HEAD differs from PR headRefOid (post-merge push)', () => {
    const result = checkUnpushedWork({
      candidate: { branch: 'story-100', prNumber: 200 },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({ revParse: { 'story-100': 'def' } }),
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'unpushed-work');
  });

  it('PROTECTS when candidate has no PR number (cannot verify merge state)', () => {
    const result = checkUnpushedWork({
      candidate: { branch: 'story-100', prNumber: null },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit(),
        ghRunner: makeGh({}),
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'no-pr-number');
  });

  it('PROTECTS when git rev-parse fails for the branch', () => {
    const result = checkUnpushedWork({
      candidate: { branch: 'story-100', prNumber: 200 },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({ revParse: {} }), // no entries → status 1
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
      },
    });
    assert.equal(result.protected, true);
    assert.match(result.reason, /rev-parse-failed/);
  });

  it('PROTECTS when gh pr view fails or returns no headRefOid', () => {
    const result = checkUnpushedWork({
      candidate: { branch: 'story-100', prNumber: 200 },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({ revParse: { 'story-100': 'abc' } }),
        ghRunner: makeGh({ 200: { error: 'gh exit 4: rate-limited' } }),
      },
    });
    assert.equal(result.protected, true);
    assert.match(result.reason, /gh-pr-view-failed/);
  });
});

describe('checkDirtyTree', () => {
  it('does NOT protect when no worktree is attached', () => {
    const result = checkDirtyTree({
      candidate: { branch: 'story-100', hasWorktree: false },
      ctx: { gitSpawn: makeGit() },
    });
    assert.deepEqual(result, { protected: false });
  });

  it('does NOT protect when worktree status is clean', () => {
    const result = checkDirtyTree({
      candidate: {
        branch: 'story-100',
        hasWorktree: true,
        worktreePath: '/wt/story-100',
      },
      ctx: { gitSpawn: makeGit({ status: { '/wt/story-100': '' } }) },
    });
    assert.deepEqual(result, { protected: false });
  });

  it('PROTECTS when worktree has uncommitted edits', () => {
    const result = checkDirtyTree({
      candidate: {
        branch: 'story-100',
        hasWorktree: true,
        worktreePath: '/wt/story-100',
      },
      ctx: {
        gitSpawn: makeGit({
          status: { '/wt/story-100': ' M src/file.js\n M tests/foo.test.js' },
        }),
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'dirty-tree');
  });

  it('PROTECTS when git status itself fails', () => {
    const result = checkDirtyTree({
      candidate: {
        branch: 'story-100',
        hasWorktree: true,
        worktreePath: '/wt/story-100',
      },
      ctx: { gitSpawn: makeGit({ status: {} }) }, // no entry → status 1
    });
    assert.equal(result.protected, true);
    assert.match(result.reason, /status-failed/);
  });
});

describe('checkTicketNotDone', () => {
  it('does NOT protect when ticket is closed', async () => {
    const result = await checkTicketNotDone({
      candidate: { branch: 'story-100' },
      ctx: {
        getTicket: async () => ({ state: 'closed', labels: [] }),
      },
    });
    assert.deepEqual(result, { protected: false });
  });

  it('does NOT protect when ticket has agent::done label', async () => {
    const result = await checkTicketNotDone({
      candidate: { branch: 'story-100' },
      ctx: {
        getTicket: async () => ({ state: 'open', labels: ['agent::done'] }),
      },
    });
    assert.deepEqual(result, { protected: false });
  });

  it('PROTECTS when ticket is still open and lacks agent::done', async () => {
    const result = await checkTicketNotDone({
      candidate: { branch: 'story-100' },
      ctx: {
        getTicket: async () => ({
          state: 'open',
          labels: ['agent::executing'],
        }),
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'ticket-not-done');
  });

  it('PROTECTS when provider getTicket throws', async () => {
    const result = await checkTicketNotDone({
      candidate: { branch: 'story-100' },
      ctx: {
        getTicket: async () => {
          throw new Error('network down');
        },
      },
    });
    assert.equal(result.protected, true);
    assert.match(result.reason, /ticket-read-failed/);
  });

  it('PROTECTS when no provider is supplied', async () => {
    const result = await checkTicketNotDone({
      candidate: { branch: 'story-100' },
      ctx: {},
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'provider-unavailable');
  });

  it('does NOT protect non-story branches (no parent ticket to query)', async () => {
    const result = await checkTicketNotDone({
      candidate: { branch: 'feature/foo' },
      ctx: { getTicket: async () => null },
    });
    assert.deepEqual(result, { protected: false });
  });
});

describe('evaluateProtection (integration)', () => {
  it('reaps a candidate that passes all three guards', async () => {
    const result = await evaluateProtection({
      candidate: {
        branch: 'story-100',
        prNumber: 200,
        hasWorktree: true,
        worktreePath: '/wt/story-100',
      },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({
          revParse: { 'story-100': 'abc' },
          status: { '/wt/story-100': '' },
        }),
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
        getTicket: async () => ({ state: 'closed', labels: [] }),
      },
    });
    assert.deepEqual(result, { protected: false });
  });

  it('short-circuits on the first failing guard (dirty-tree wins over ticket)', async () => {
    let ticketCalls = 0;
    const result = await evaluateProtection({
      candidate: {
        branch: 'story-100',
        prNumber: 200,
        hasWorktree: true,
        worktreePath: '/wt/story-100',
      },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({
          revParse: { 'story-100': 'abc' },
          status: { '/wt/story-100': ' M dirty.js' },
        }),
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
        getTicket: async () => {
          ticketCalls += 1;
          return { state: 'open', labels: [] };
        },
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'dirty-tree');
    assert.equal(
      ticketCalls,
      0,
      'ticket lookup short-circuits when dirty-tree wins',
    );
  });

  it('detects unpushed-work even when worktree is clean and ticket is done', async () => {
    const result = await evaluateProtection({
      candidate: {
        branch: 'story-100',
        prNumber: 200,
        hasWorktree: true,
        worktreePath: '/wt/story-100',
      },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({
          revParse: { 'story-100': 'def' },
          status: { '/wt/story-100': '' },
        }),
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
        getTicket: async () => ({ state: 'closed', labels: [] }),
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'unpushed-work');
  });

  it('flags ticket-not-done when branch is clean and merge state matches', async () => {
    const result = await evaluateProtection({
      candidate: {
        branch: 'story-100',
        prNumber: 200,
        hasWorktree: false,
        worktreePath: null,
      },
      ctx: {
        repoRoot: '/repo',
        gitSpawn: makeGit({ revParse: { 'story-100': 'abc' } }),
        ghRunner: makeGh({ 200: { headRefOid: 'abc' } }),
        getTicket: async () => ({
          state: 'open',
          labels: ['agent::executing'],
        }),
      },
    });
    assert.equal(result.protected, true);
    assert.equal(result.reason, 'ticket-not-done');
  });
});
