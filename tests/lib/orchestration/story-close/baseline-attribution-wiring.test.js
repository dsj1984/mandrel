import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeStoryDiffPaths,
  handleBaselineGateFailure,
  runPreMergeGatesWithAttribution,
  runRefreshCommit,
  validateProjectionContext,
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
    // Verified ordering: add, status, log (prior-refresh probe added by
    // Story #2176), commit, rev-parse. The probe returns an empty subject
    // by default so the "fresh commit" path runs unchanged.
    assert.deepEqual(
      calls.map((c) => c.args[0]),
      ['add', 'status', 'log', 'commit', 'rev-parse'],
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
    const upsertStructuredComment = async (_provider, ticketId, type, body) => {
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
      agentSettings: {},
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
      agentSettings: {},
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

  it('returns blocked-timeout when coverage-capture exits 124 (no retry, no attribution work)', async () => {
    // Story #2136 / Task #2143 — a coverage hang must short-circuit before
    // the attribution refresh flow (which assumes baseline drift, not a
    // runaway runner). `handleBaselineGateFailureFn` and
    // `projectRegressionsFn` MUST NOT be called.
    let preMergeAttempts = 0;
    let handleCalled = false;
    let projectCalled = false;
    const runPreMergeGates = () => {
      preMergeAttempts += 1;
      const err = new Error(
        'Pre-merge validation failed at "coverage-capture" (exit 124) in /repo.',
      );
      err.code = 'PRE_MERGE_GATE_FAILED';
      err.gateName = 'coverage-capture';
      err.exitCode = 124;
      throw err;
    };
    const result = await runPreMergeGatesWithAttribution({
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-2136',
      epicBranch: 'epic/2129',
      storyBranch: 'story-2136',
      agentSettings: {},
      storyId: 2136,
      epicId: 2129,
      useEvidence: false,
      provider: {},
      runPreMergeGates,
      handleBaselineGateFailureFn: async () => {
        handleCalled = true;
        return { action: 'rethrow' };
      },
      projectRegressionsFn: () => {
        projectCalled = true;
        return [];
      },
    });
    assert.equal(result.status, 'blocked-timeout');
    assert.equal(result.gateName, 'coverage-capture');
    assert.equal(result.exitCode, 124);
    assert.equal(preMergeAttempts, 1);
    assert.equal(handleCalled, false, 'attribution refresh must not fire');
    assert.equal(projectCalled, false, 'regression projection must not fire');
  });

  it('does NOT short-circuit when coverage-capture exits non-124 (e.g. failing tests stay loud)', async () => {
    const runPreMergeGates = () => {
      const err = new Error(
        'Pre-merge validation failed at "coverage-capture" (exit 1) in /repo.',
      );
      err.gateName = 'coverage-capture';
      err.exitCode = 1;
      throw err;
    };
    await assert.rejects(
      runPreMergeGatesWithAttribution({
        cwd: '/repo',
        worktreePath: '/repo/.worktrees/story-2136',
        epicBranch: 'epic/2129',
        storyBranch: 'story-2136',
        agentSettings: {},
        storyId: 2136,
        epicId: 2129,
        useEvidence: false,
        provider: {},
        runPreMergeGates,
        handleBaselineGateFailureFn: async () => ({ action: 'rethrow' }),
        projectRegressionsFn: () => [],
      }),
      /failed at "coverage-capture" \(exit 1\)/,
    );
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
        agentSettings: {},
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

describe('runRefreshCommit — Story #2176 single-commit invariant', () => {
  it('skips with no-baseline-drift when staged tree matches prior refresh commit', () => {
    const cycleState = { priorRefreshSha: 'abc1234' };
    const spawnSync = () => ({ status: 0 });
    const { gitRunner, calls } = makeRecordingGit({
      'add -u': { status: 0 },
      'status --porcelain': {
        status: 0,
        stdout: ' M baselines/maintainability.json',
      },
      // Staged tree byte-for-byte matches the prior commit's tree.
      'diff --cached abc1234': { status: 0, stdout: '' },
      'reset HEAD --': { status: 0 },
    });
    const result = runRefreshCommit({
      cwd: '/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      cycleState,
      spawnSync,
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-baseline-drift');
    assert.equal(result.sha, 'abc1234');
    // Critical: no `commit` call landed.
    assert.ok(
      !calls.some((c) => c.args[0] === 'commit'),
      'no commit should be emitted when staged tree matches prior refresh',
    );
  });

  it('amends prior refresh commit when staged tree differs (no sibling commit)', () => {
    const cycleState = { priorRefreshSha: 'abc1234' };
    const spawnSync = () => ({ status: 0 });
    const { gitRunner, calls } = makeRecordingGit({
      'add -u': { status: 0 },
      'status --porcelain': {
        status: 0,
        stdout: ' M baselines/maintainability.json',
      },
      'diff --cached abc1234': { status: 0, stdout: 'drift\n' },
      'commit --amend --no-edit': { status: 0 },
      'rev-parse --short HEAD': { status: 0, stdout: 'def5678' },
    });
    const result = runRefreshCommit({
      cwd: '/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      cycleState,
      spawnSync,
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.amended, true);
    assert.equal(result.sha, 'def5678');
    assert.equal(cycleState.priorRefreshSha, 'def5678');
    // Critical: amend ran, no `commit -m` sibling was emitted.
    const commitCalls = calls.filter((c) => c.args[0] === 'commit');
    assert.equal(commitCalls.length, 1);
    assert.deepEqual(commitCalls[0].args, ['commit', '--amend', '--no-edit']);
  });

  it('detects prior refresh at HEAD when cycleState is absent (multi-invocation safety)', () => {
    const spawnSync = () => ({ status: 0 });
    const { gitRunner, calls } = makeRecordingGit({
      'add -u': { status: 0 },
      'status --porcelain': {
        status: 0,
        stdout: ' M baselines/maintainability.json',
      },
      'log -1 --format=%s HEAD': {
        status: 0,
        stdout: 'baseline-refresh: maintainability',
      },
      'rev-parse HEAD': { status: 0, stdout: 'cafe9999' },
      'diff --cached cafe9999': { status: 0, stdout: 'drift\n' },
      'commit --amend --no-edit': { status: 0 },
      'rev-parse --short HEAD': { status: 0, stdout: 'beef1111' },
    });
    const result = runRefreshCommit({
      cwd: '/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      // No cycleState — second story-close invocation; HEAD inspection
      // still folds the new refresh into the prior commit.
      spawnSync,
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.amended, true);
    assert.equal(result.sha, 'beef1111');
    const commitCalls = calls.filter((c) => c.args[0] === 'commit');
    assert.equal(commitCalls.length, 1);
    assert.deepEqual(commitCalls[0].args, ['commit', '--amend', '--no-edit']);
  });
});

describe('runPreMergeGatesWithAttribution — single-commit invariant across retries (Story #2176)', () => {
  it('synthetic 3-attempt retry (fail, fail, pass) lands ≤1 baseline-refresh commit', async () => {
    // Drives the real runRefreshCommit via the real handleBaselineGateFailure
    // (with a stub classifier that returns all-attributable) so we can count
    // actual git commit invocations across the retry loop.
    let preMergeAttempts = 0;
    const runPreMergeGates = () => {
      preMergeAttempts += 1;
      if (preMergeAttempts < 3) {
        throw new Error(
          'Pre-merge validation failed at "check-maintainability" (exit 1) in /repo.',
        );
      }
      // Attempt 3 succeeds.
    };

    // Record every gitSpawn call across all attempts.
    const allCalls = [];
    let attemptIndex = 0;
    const gitSpawn = (cwd, ...args) => {
      allCalls.push({ attemptIndex, cwd, args });
      const key = args.join(' ');
      // Story-diff (attribution classifier) — empty diff so classifier
      // treats every regression as touched-only (attributable).
      if (key === 'diff --name-only origin/epic/2129...story-2176') {
        return { status: 0, stdout: 'lib/touched.js\n', stderr: '' };
      }
      if (key === 'add -u') return { status: 0 };
      if (key === 'status --porcelain') {
        return { status: 0, stdout: ' M baselines/maintainability.json' };
      }
      // First attempt: no prior refresh.
      if (key === 'log -1 --format=%s HEAD' && attemptIndex === 1) {
        return { status: 0, stdout: 'feat(x): unrelated' };
      }
      // First attempt commit: fresh.
      if (key === 'commit -m baseline-refresh: maintainability') {
        return { status: 0 };
      }
      if (key === 'rev-parse --short HEAD') {
        return { status: 0, stdout: `sha${attemptIndex}` };
      }
      // Subsequent attempts: prior refresh present via cycleState; staged
      // tree differs → amend.
      if (key.startsWith('diff --cached ')) {
        return { status: 0, stdout: 'drift\n' };
      }
      if (key === 'commit --amend --no-edit') return { status: 0 };
      return { status: 0, stdout: '', stderr: '' };
    };

    const handleBaselineGateFailureFn = async (input) => {
      attemptIndex += 1;
      return handleBaselineGateFailure({
        ...input,
        deps: { gitRunner: { gitSpawn }, spawnSync: () => ({ status: 0 }) },
      });
    };

    const result = await runPreMergeGatesWithAttribution({
      cwd: '/repo',
      worktreePath: '/repo',
      epicBranch: 'epic/2129',
      storyBranch: 'story-2176',
      agentSettings: {},
      storyId: 2176,
      epicId: 2129,
      useEvidence: false,
      provider: {},
      runPreMergeGates,
      handleBaselineGateFailureFn,
      projectRegressionsFn: ({ gateName }) =>
        gateName === 'check-maintainability'
          ? [{ path: 'lib/touched.js' }]
          : [],
      maxAttempts: 3,
    });

    assert.equal(result.status, 'ok');
    assert.equal(preMergeAttempts, 3);

    // AC #1: at most one `commit -m baseline-refresh:` invocation lands.
    const freshCommits = allCalls.filter(
      (c) =>
        c.args[0] === 'commit' &&
        c.args[1] === '-m' &&
        typeof c.args[2] === 'string' &&
        c.args[2].startsWith('baseline-refresh:'),
    );
    assert.equal(
      freshCommits.length,
      1,
      'exactly one fresh baseline-refresh commit lands across the retry sequence',
    );

    // Subsequent retry MUST have used amend, not a fresh sibling.
    const amends = allCalls.filter(
      (c) =>
        c.args[0] === 'commit' &&
        c.args[1] === '--amend' &&
        c.args[2] === '--no-edit',
    );
    assert.equal(amends.length, 1, 'second retry folded via amend');
  });
});

describe('validateProjectionContext (predicate)', () => {
  const cases = [
    {
      name: 'all three fields populated → true',
      ctx: { cwd: '/r', epicBranch: 'epic/1', storyBranch: 'story-2' },
      expected: true,
    },
    {
      name: 'missing cwd → false',
      ctx: { cwd: '', epicBranch: 'epic/1', storyBranch: 'story-2' },
      expected: false,
    },
    {
      name: 'null cwd → false',
      ctx: { cwd: null, epicBranch: 'epic/1', storyBranch: 'story-2' },
      expected: false,
    },
    {
      name: 'undefined cwd → false',
      ctx: { epicBranch: 'epic/1', storyBranch: 'story-2' },
      expected: false,
    },
    {
      name: 'missing epicBranch → false',
      ctx: { cwd: '/r', epicBranch: '', storyBranch: 'story-2' },
      expected: false,
    },
    {
      name: 'null epicBranch → false',
      ctx: { cwd: '/r', epicBranch: null, storyBranch: 'story-2' },
      expected: false,
    },
    {
      name: 'missing storyBranch → false',
      ctx: { cwd: '/r', epicBranch: 'epic/1', storyBranch: '' },
      expected: false,
    },
    {
      name: 'null storyBranch → false',
      ctx: { cwd: '/r', epicBranch: 'epic/1', storyBranch: null },
      expected: false,
    },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      assert.equal(validateProjectionContext(tc.ctx), tc.expected);
    });
  }
});
