import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeStoryDiffPaths,
  handleBaselineGateFailure,
  runPreMergeGatesWithAttribution,
  runRefreshCommit,
} from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js';
import { renderBaselineFrictionBody } from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-friction-body.js';

/**
 * Story #1124 / Task #1134 — wiring tests.
 *
 * Asserts the integration path described in the Tech Spec:
 *
 *   - mock classifier returns mixed rows
 *   - assert auto-refresh commit lands on the Story branch
 *   - assert friction comment was posted via the provider
 *   - assert close returns blocked
 *
 * The runner-level test for `runPreMergeGatesWithAttribution` exercises
 * the bounded-retry contract: one gate failure → refresh → re-run gates →
 * second pass succeeds → status `ok`.
 */

function makeRecordingGit(plan = {}) {
  const calls = [];
  const gitSpawn = (cwd, ...args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (Object.hasOwn(plan, key)) {
      const v = plan[key];
      return typeof v === 'function' ? v(calls) : v;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { gitRunner: { gitSpawn }, calls };
}

describe('runRefreshCommit — Story branch refresh path', () => {
  it('runs the refresh command, stages, commits, and returns the new SHA', () => {
    const spawnCalls = [];
    const spawnSync = (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return { status: 0 };
    };
    const { gitRunner, calls } = makeRecordingGit({
      'add -u': { status: 0, stdout: '', stderr: '' },
      'status --porcelain': {
        status: 0,
        stdout: ' M baselines/maintainability.json',
        stderr: '',
      },
      'commit -m baseline-refresh: maintainability': {
        status: 0,
        stdout: '',
        stderr: '',
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'cafe1111', stderr: '' },
    });
    const result = runRefreshCommit({
      cwd: '/repo/.worktrees/story-1124',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      spawnSync,
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sha, 'cafe1111');
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'npm');
    assert.deepEqual(spawnCalls[0].args, ['run', 'maintainability:update']);
    // Verified ordering: add, status, commit, rev-parse.
    assert.deepEqual(
      calls.map((c) => c.args[0]),
      ['add', 'status', 'commit', 'rev-parse'],
    );
  });

  it('treats an empty refresh diff as failure (no commit lands)', () => {
    const spawnSync = () => ({ status: 0 });
    const { gitRunner } = makeRecordingGit({
      'add -u': { status: 0, stdout: '', stderr: '' },
      'status --porcelain': { status: 0, stdout: '', stderr: '' },
    });
    const result = runRefreshCommit({
      cwd: '/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      spawnSync,
      gitRunner,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no diff/);
  });

  it('surfaces a non-zero refresh-command exit', () => {
    const spawnSync = () => ({ status: 7 });
    const { gitRunner } = makeRecordingGit();
    const result = runRefreshCommit({
      cwd: '/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      spawnSync,
      gitRunner,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /exited 7/);
  });
});

describe('handleBaselineGateFailure — full split routing', () => {
  it('non-baseline gate name → action: rethrow (typecheck/lint/test all bubble up)', async () => {
    const result = await handleBaselineGateFailure({
      gateName: 'lint',
      regressions: [{ path: 'lib/x.js' }],
      cwd: '/repo',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      storyId: 1124,
      epicId: 1114,
      provider: { postComment: () => assert.fail('should not post') },
    });
    assert.equal(result.action, 'rethrow');
  });

  it('all-attributable rows → runs refresh + commit and returns refreshed', async () => {
    let upsertCalls = 0;
    const spawnSync = () => ({ status: 0 });
    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1114...story-1124': {
        status: 0,
        stdout: 'lib/touched.js\n',
        stderr: '',
      },
      'add -u': { status: 0 },
      'status --porcelain': {
        status: 0,
        stdout: ' M baselines/maintainability.json',
      },
      'commit -m baseline-refresh: maintainability': { status: 0 },
      'rev-parse --short HEAD': { status: 0, stdout: 'feed1234' },
    });
    const result = await handleBaselineGateFailure({
      gateName: 'check-maintainability',
      regressions: [{ path: 'lib/touched.js' }],
      cwd: '/repo',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      storyId: 1124,
      epicId: 1114,
      provider: {
        postComment: () => {
          upsertCalls += 1;
          return { commentId: 9 };
        },
      },
      deps: {
        gitRunner,
        spawnSync,
        // Force the path through the real classifier without any custom
        // suspect lookup — touched paths short-circuit the suspect spawn.
      },
    });
    assert.equal(result.action, 'refreshed');
    assert.equal(result.sha, 'feed1234');
    assert.equal(
      upsertCalls,
      0,
      'must not upsert friction when all-attributable',
    );
  });

  it('mixed rows with non-attributable present → posts friction, returns blocked, no auto-commit', async () => {
    const spawnCalls = [];
    const spawnSync = (...a) => {
      spawnCalls.push(a);
      return { status: 0 };
    };
    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1114...story-1124': {
        status: 0,
        stdout: 'lib/touched.js\n',
      },
      'log --oneline -n 1 origin/epic/1114 -- lib/sibling.js': {
        status: 0,
        stdout: 'cafe9999 refactor(x): bump (resolves #777)',
      },
    });
    const upsertSpy = { calls: [] };
    const upsertStructuredComment = async (provider, ticketId, type, body) => {
      upsertSpy.calls.push({ ticketId, type, body });
      return { commentId: 42 };
    };
    const result = await handleBaselineGateFailure({
      gateName: 'check-maintainability',
      regressions: [{ path: 'lib/touched.js' }, { path: 'lib/sibling.js' }],
      cwd: '/repo',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      storyId: 1124,
      epicId: 1114,
      provider: {},
      deps: { gitRunner, spawnSync, upsertStructuredComment },
    });
    assert.equal(result.action, 'blocked');
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.nonAttributable[0].path, 'lib/sibling.js');
    assert.equal(result.nonAttributable[0].suspectStoryNumber, 777);
    assert.equal(result.commentId, 42);
    // Critical AC #3: no baseline-refresh commit was issued.
    assert.equal(spawnCalls.length, 0);
    // Friction comment was posted with the right type + ticket.
    assert.equal(upsertSpy.calls.length, 1);
    assert.equal(upsertSpy.calls[0].ticketId, 1124);
    assert.equal(upsertSpy.calls[0].type, 'friction');
    assert.match(upsertSpy.calls[0].body, /Story #1124/);
    assert.match(upsertSpy.calls[0].body, /lib\/sibling\.js/);
    assert.match(upsertSpy.calls[0].body, /#777/);
  });

  it('empty regressions → action: rethrow (gate failed for a non-regression reason)', async () => {
    const result = await handleBaselineGateFailure({
      gateName: 'check-maintainability',
      regressions: [],
      cwd: '/repo',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      storyId: 1124,
      epicId: 1114,
      provider: {},
    });
    assert.equal(result.action, 'rethrow');
  });
});

describe('renderBaselineFrictionBody — comment shape', () => {
  it('renders heading + table + triage with each row populated', () => {
    const body = renderBaselineFrictionBody({
      rows: [
        {
          path: 'lib/sibling.js',
          suspectSha: 'cafe9999',
          suspectStoryNumber: 777,
        },
        {
          path: 'lib/orphan.js',
          suspectSha: 'beef0001',
          suspectStoryNumber: null,
        },
      ],
      storyId: 1124,
      epicId: 1114,
    });
    assert.match(body, /Story #1124/);
    assert.match(body, /epic\/1114/);
    assert.match(body, /lib\/sibling\.js/);
    assert.match(body, /#777/);
    assert.match(body, /lib\/orphan\.js/);
    assert.match(body, /_unknown_/);
    assert.match(body, /`cafe9999`/);
    assert.match(body, /Triage/);
  });

  it('emits a defensive body when rows is empty', () => {
    const body = renderBaselineFrictionBody({
      rows: [],
      storyId: 1124,
      epicId: 1114,
    });
    assert.match(body, /defensively/);
  });
});

describe('computeStoryDiffPaths', () => {
  it('returns the diff list with backslashes normalized to forward slashes', () => {
    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1114...story-1124': {
        status: 0,
        stdout: 'lib/a.js\nlib\\b.js\n  \nlib/c.js\n',
      },
    });
    const paths = computeStoryDiffPaths({
      cwd: '/repo',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      gitRunner,
    });
    assert.deepEqual(paths, ['lib/a.js', 'lib/b.js', 'lib/c.js']);
  });

  it('returns [] on a non-zero diff exit so all rows fall through to non-attributable', () => {
    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1114...story-1124': {
        status: 128,
        stdout: '',
        stderr: 'unknown ref',
      },
    });
    const paths = computeStoryDiffPaths({
      cwd: '/repo',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      gitRunner,
    });
    assert.deepEqual(paths, []);
  });
});

describe('runPreMergeGatesWithAttribution — bounded retry contract', () => {
  it('retries the gate chain once after a successful auto-refresh and returns ok', async () => {
    let preMergeAttempts = 0;
    const runPreMergeGates = () => {
      preMergeAttempts += 1;
      if (preMergeAttempts === 1) {
        const err = new Error(
          'Pre-merge validation failed at "check-maintainability" (exit 1) in /repo.',
        );
        throw err;
      }
      // Second pass succeeds.
    };
    const handleBaselineGateFailureFn = async ({ gateName }) => {
      assert.equal(gateName, 'check-maintainability');
      return { action: 'refreshed', sha: 'feed4242' };
    };
    const projectRegressionsFn = ({ gateName }) =>
      gateName === 'check-maintainability' ? [{ path: 'lib/x.js' }] : [];
    const result = await runPreMergeGatesWithAttribution({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-1124',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      settings: {},
      storyId: 1124,
      epicId: 1114,
      useEvidence: false,
      provider: {},
      runPreMergeGates,
      handleBaselineGateFailureFn,
      projectRegressionsFn,
    });
    assert.equal(result.status, 'ok');
    assert.equal(preMergeAttempts, 2);
  });

  it('returns blocked when handleBaselineGateFailure reports blocked (no retry)', async () => {
    let preMergeAttempts = 0;
    const runPreMergeGates = () => {
      preMergeAttempts += 1;
      throw new Error(
        'Pre-merge validation failed at "check-maintainability" (exit 1) in /repo.',
      );
    };
    const handleBaselineGateFailureFn = async () => ({
      action: 'blocked',
      nonAttributable: [
        { path: 'lib/sibling.js', suspectStoryNumber: 777, suspectSha: 'cafe' },
      ],
      commentId: 42,
    });
    const result = await runPreMergeGatesWithAttribution({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-1124',
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      settings: {},
      storyId: 1124,
      epicId: 1114,
      useEvidence: false,
      provider: {},
      runPreMergeGates,
      handleBaselineGateFailureFn,
      projectRegressionsFn: () => [{ path: 'lib/sibling.js' }],
    });
    assert.equal(result.status, 'blocked');
    assert.equal(preMergeAttempts, 1);
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.commentId, 42);
  });

  it('rethrows the original gate error on action: rethrow (non-baseline failures stay loud)', async () => {
    const runPreMergeGates = () => {
      throw new Error(
        'Pre-merge validation failed at "lint" (exit 1) in /repo.',
      );
    };
    const handleBaselineGateFailureFn = async () => ({ action: 'rethrow' });
    await assert.rejects(
      runPreMergeGatesWithAttribution({
        cwd: '/repo',
        worktreePath: '/repo/.worktrees/story-1124',
        epicBranch: 'epic/1114',
        storyBranch: 'story-1124',
        settings: {},
        storyId: 1124,
        epicId: 1114,
        useEvidence: false,
        provider: {},
        runPreMergeGates,
        handleBaselineGateFailureFn,
        projectRegressionsFn: () => [],
      }),
      /failed at "lint"/,
    );
  });
});
