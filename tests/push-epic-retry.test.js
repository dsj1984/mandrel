import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, test } from 'node:test';

import {
  isNonFastForwardPush,
  PushRetryConflictError,
  pushEpicWithRetry,
} from '../.agents/scripts/lib/push-epic-retry.js';

// ---------------------------------------------------------------------------
// isNonFastForwardPush — stderr signature detection
// ---------------------------------------------------------------------------

describe('isNonFastForwardPush', () => {
  const cases = [
    ['! [rejected]        epic/668 -> epic/668 (non-fast-forward)', true],
    ['hint: Updates were rejected because the tip of your current', true],
    ['error: failed to push some refs to origin', true],
    ['hint: (e.g., "git pull ...") before pushing again.', false],
    ['error: remote denied access', false],
    ['fatal: unable to access', false],
    ['[rejected]', true],
    ['', false],
  ];
  for (const [stderr, expected] of cases) {
    it(`${expected ? 'matches' : 'rejects'} ${JSON.stringify(stderr.slice(0, 40))}`, () => {
      assert.equal(isNonFastForwardPush(stderr), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// pushEpicWithRetry — mock-based branch coverage
// ---------------------------------------------------------------------------

/**
 * Build a scripted gitSpawn mock. Each call is matched by the command
 * signature (first argument after cwd); scripted results are consumed in
 * order per signature. Unmatched calls return `{ status: 0, stdout: '', stderr: '' }`.
 */
function makeGit(script) {
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const calls = [];
  const gitSpawn = (cwd, ...args) => {
    calls.push({ cwd, args });
    const key = args[0];
    const q = queues.get(key);
    if (q?.length) return q.shift();
    return { status: 0, stdout: '', stderr: '' };
  };
  return { git: { gitSpawn }, calls };
}

describe('pushEpicWithRetry — single-session happy path', () => {
  it('first push succeeds: no fetch, no reset, no merge', async () => {
    const { git, calls } = makeGit({
      push: [{ status: 0, stdout: '', stderr: '' }],
    });
    const result = await pushEpicWithRetry({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-2',
      git,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), ['push', '--no-verify']);
  });
});

describe('pushEpicWithRetry — retry on non-fast-forward', () => {
  it('retries on non-ff, fetches + resets + reapplies, then pushes', async () => {
    const { git, calls } = makeGit({
      push: [
        { status: 1, stdout: '', stderr: '! [rejected] non-fast-forward' },
        { status: 0, stdout: '', stderr: '' },
      ],
      fetch: [{ status: 0, stdout: '', stderr: '' }],
      reset: [{ status: 0, stdout: '', stderr: '' }],
      merge: [{ status: 0, stdout: '', stderr: '' }],
    });
    const sleeps = [];
    const sleep = async (ms) => {
      sleeps.push(ms);
    };
    const result = await pushEpicWithRetry({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-2',
      storyMergeRetry: { maxAttempts: 3, backoffMs: [10, 20, 30] },
      git,
      sleep,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleeps, [10]);
    const sequence = calls.map((c) => c.args[0]);
    assert.deepEqual(sequence, ['push', 'fetch', 'reset', 'merge', 'push']);
    // reset target
    assert.equal(calls[2].args.join(' '), 'reset --hard origin/epic/1');
    // merge reapplies story branch
    assert.deepEqual(calls[3].args, [
      'merge',
      '--no-ff',
      '--no-edit',
      'story-2',
    ]);
  });

  it('gives up after maxAttempts and reports retry-exhausted', async () => {
    const { git } = makeGit({
      push: [
        { status: 1, stdout: '', stderr: 'non-fast-forward' },
        { status: 1, stdout: '', stderr: 'non-fast-forward' },
      ],
      fetch: [{ status: 0, stdout: '', stderr: '' }],
      reset: [{ status: 0, stdout: '', stderr: '' }],
      merge: [{ status: 0, stdout: '', stderr: '' }],
    });
    const result = await pushEpicWithRetry({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-2',
      storyMergeRetry: { maxAttempts: 2, backoffMs: [0] },
      git,
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'retry-exhausted');
    assert.equal(result.attempts, 2);
  });

  it('uses default storyMergeRetry when none provided (3 attempts, 3 backoffs)', async () => {
    const { git } = makeGit({
      push: [
        { status: 1, stdout: '', stderr: 'non-fast-forward' },
        { status: 1, stdout: '', stderr: 'non-fast-forward' },
        { status: 1, stdout: '', stderr: 'non-fast-forward' },
      ],
    });
    const sleeps = [];
    const result = await pushEpicWithRetry({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-2',
      git,
      sleep: async (ms) => sleeps.push(ms),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'retry-exhausted');
    assert.equal(result.attempts, 3);
    assert.deepEqual(sleeps, [250, 500]);
  });
});

describe('pushEpicWithRetry — non-retryable push errors', () => {
  it('surfaces non-ff-unrelated push errors immediately', async () => {
    const { git, calls } = makeGit({
      push: [
        {
          status: 1,
          stdout: '',
          stderr: 'ERROR: Permission to org/repo.git denied',
        },
      ],
    });
    const result = await pushEpicWithRetry({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-2',
      storyMergeRetry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
      git,
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'non-retryable-push-error');
    assert.equal(result.attempts, 1);
    assert.equal(calls.length, 1);
  });
});

describe('pushEpicWithRetry — content-conflict abort', () => {
  it('throws PushRetryConflictError with conflict filenames and aborts merge', async () => {
    const { git, calls } = makeGit({
      push: [{ status: 1, stdout: '', stderr: 'non-fast-forward' }],
      fetch: [{ status: 0, stdout: '', stderr: '' }],
      reset: [{ status: 0, stdout: '', stderr: '' }],
      merge: [
        {
          status: 1,
          stdout: 'CONFLICT (content): Merge conflict in foo.js',
          stderr: 'Automatic merge failed',
        },
      ],
      diff: [{ status: 0, stdout: 'foo.js\nbar/baz.js', stderr: '' }],
    });
    await assert.rejects(
      () =>
        pushEpicWithRetry({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-2',
          storyMergeRetry: { maxAttempts: 3, backoffMs: [0, 0] },
          git,
          sleep: async () => {},
        }),
      (err) => {
        assert.ok(err instanceof PushRetryConflictError);
        assert.deepEqual(err.conflictFiles, ['foo.js', 'bar/baz.js']);
        assert.match(err.message, /Content conflict/);
        assert.match(err.message, /foo\.js/);
        assert.match(err.message, /working tree is clean/);
        return true;
      },
    );
    // merge --abort must have been called after conflict detection
    const abortCall = calls.find(
      (c) => c.args[0] === 'merge' && c.args.includes('--abort'),
    );
    assert.ok(abortCall, 'merge --abort must be invoked to clean tree');
  });
});

describe('pushEpicWithRetry — fetch failure mid-retry', () => {
  it('returns fetch-failed reason without further attempts', async () => {
    const { git } = makeGit({
      push: [{ status: 1, stdout: '', stderr: 'non-fast-forward' }],
      fetch: [
        {
          status: 128,
          stdout: '',
          stderr: 'fatal: unable to access origin',
        },
      ],
    });
    const result = await pushEpicWithRetry({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-2',
      storyMergeRetry: { maxAttempts: 3, backoffMs: [0, 0] },
      git,
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fetch-failed');
  });
});

// ---------------------------------------------------------------------------
// Integration fixture — real git with a bare origin + two local clones.
// Exercises the end-to-end contract:
//   (a) second session pushes between our fetch and our push -> our push
//       succeeds on retry.
//   (b) real content conflict -> clean error, recoverable tree.
//   (c) single-session path leaves origin in an identical state to a plain
//       `git push`.
// ---------------------------------------------------------------------------

// Strip every GIT_* env var so the fixture's tmpdir cwd wins. When this
// test runs inside a git hook (e.g. husky pre-push) the parent git
// invocation exports a constellation of GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE / GIT_PREFIX / GIT_COMMON_DIR / etc. that override
// execFileSync's `cwd`, making every fixture-internal `git add` /
// `git commit` operate on the parent repo instead of the tmpdir.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const GIT_ENV = {
  ...CLEAN_ENV,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: GIT_ENV,
  }).trim();
}

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'push-epic-retry-'));
  const bare = join(root, 'origin.git');
  const session1 = join(root, 's1');
  const session2 = join(root, 's2');

  git(root, 'init', '--bare', '--initial-branch=main', 'origin.git');
  git(root, 'clone', bare, 's1');
  // Seed initial commit on main + the epic branch.
  writeFileSync(join(session1, 'README.md'), 'seed\n');
  git(session1, 'add', '.');
  git(session1, 'commit', '-m', 'seed');
  git(session1, 'push', 'origin', 'main');
  git(session1, 'checkout', '-b', 'epic/1');
  git(session1, 'push', '-u', 'origin', 'epic/1');

  // Shared object store — faster than a cold clone, still independent
  // working trees so both sessions can check out epic/1 concurrently.
  git(root, 'clone', '--shared', bare, 's2');
  git(session2, 'checkout', 'epic/1');

  return { root, bare, session1, session2 };
}

function makeStoryCommit(cwd, storyBranch, file, content, message) {
  git(cwd, 'checkout', '-b', storyBranch, 'epic/1');
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', message);
  git(cwd, 'checkout', 'epic/1');
  git(cwd, 'merge', '--no-ff', '--no-edit', storyBranch);
}

// Real-git shim that shells out. The retry helper only needs gitSpawn.
const realGit = {
  gitSpawn(cwd, ...args) {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: GIT_ENV,
      });
      return { status: 0, stdout: stdout.trim(), stderr: '' };
    } catch (err) {
      return {
        status: err.status ?? 1,
        stdout: (err.stdout?.toString() ?? '').trim(),
        stderr: (err.stderr?.toString() ?? '').trim(),
      };
    }
  },
};

describe('pushEpicWithRetry — integration (real git, bare origin)', () => {
  let fixture;
  beforeEach(() => {
    fixture = setupFixture();
  });
  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test('(a) sibling session push lands between our fetch and push — we retry and succeed', async () => {
    const { session1, session2 } = fixture;

    // Session 1 prepares a merge locally but has not pushed yet.
    makeStoryCommit(session1, 'story-10', 'a.txt', 's1 content\n', 'story 10');

    // Session 2 lands its story first.
    makeStoryCommit(session2, 'story-20', 'b.txt', 's2 content\n', 'story 20');
    git(session2, 'push', 'origin', 'epic/1');

    // Session 1 now pushes: first push will be rejected; retry path kicks in.
    const result = await pushEpicWithRetry({
      cwd: session1,
      epicBranch: 'epic/1',
      storyBranch: 'story-10',
      storyMergeRetry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
      git: realGit,
      sleep: async () => {},
    });
    assert.equal(
      result.ok,
      true,
      `retry should succeed; reason=${result.reason}`,
    );
    assert.ok(result.attempts >= 2, 'should have taken >= 2 attempts');

    // Origin now contains both stories.
    const log = git(session1, 'log', '--oneline', 'origin/epic/1');
    assert.match(log, /story 10/);
    assert.match(log, /story 20/);
  });

  test('(b) real content conflict — PushRetryConflictError with clean tree', async () => {
    const { session1, session2 } = fixture;

    // Both sessions touch the same file with incompatible content.
    makeStoryCommit(
      session1,
      'story-10',
      'shared.txt',
      'from-s1\n',
      'story 10',
    );
    makeStoryCommit(
      session2,
      'story-20',
      'shared.txt',
      'from-s2\n',
      'story 20',
    );
    git(session2, 'push', 'origin', 'epic/1');

    await assert.rejects(
      () =>
        pushEpicWithRetry({
          cwd: session1,
          epicBranch: 'epic/1',
          storyBranch: 'story-10',
          storyMergeRetry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
          git: realGit,
          sleep: async () => {},
        }),
      (err) => {
        assert.ok(err instanceof PushRetryConflictError);
        assert.ok(err.conflictFiles.includes('shared.txt'));
        return true;
      },
    );

    // Working tree must be clean — no MERGE_HEAD, no unmerged paths.
    const status = git(session1, 'status', '--porcelain');
    assert.equal(status, '', `expected clean tree, got: ${status}`);
    const unmerged = realGit.gitSpawn(
      session1,
      'diff',
      '--name-only',
      '--diff-filter=U',
    );
    assert.equal(unmerged.stdout, '');
  });

  test('(c) single-session — first-attempt push, origin state identical to plain push', async () => {
    const { session1, bare } = fixture;

    makeStoryCommit(session1, 'story-10', 'a.txt', 's1 content\n', 'story 10');
    const localHead = git(session1, 'rev-parse', 'HEAD');

    const result = await pushEpicWithRetry({
      cwd: session1,
      epicBranch: 'epic/1',
      storyBranch: 'story-10',
      storyMergeRetry: { maxAttempts: 3, backoffMs: [0, 0, 0] },
      git: realGit,
      sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.attempts,
      1,
      'single-session must land on first attempt',
    );

    const originHead = git(bare, 'rev-parse', 'epic/1');
    assert.equal(
      originHead,
      localHead,
      'origin epic/1 tip must exactly match local HEAD — no extra commits',
    );
  });
});
