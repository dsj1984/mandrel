import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeStoryDiffPaths,
  handleBaselineGateFailure,
  runPreMergeGatesWithAttribution,
  runRefreshCommit,
  stageAndCheckBaselineDrift,
  validateProjectionContext,
} from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js';
import { renderBaselineFrictionBody } from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-friction-body.js';

/**
 * Story #1124 / Task #1134 — wiring tests, rebased onto the Story #2205
 * commit-hygiene contract:
 *
 *   - Refresh path flows through `refreshBaseline()` from
 *     `.agents/scripts/lib/baselines/refresh-service.js`. No `npm run …:update` shell-out.
 *   - Post-refresh hygiene: stage + `git diff --cached --exit-code`,
 *     then either skip (empty diff) or emit one canonical
 *     `chore(baselines): refresh <kind> for story-<id>` commit.
 *   - No `--amend`, no `--allow-empty`, ever.
 *   - Retry loop is gated by `cycleState.refreshedKinds` so a fail-then-
 *     pass sequence emits at most one refresh commit per kind per cycle
 *     (AC-9, inherited from #2176-fixture).
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

const AGENT_SETTINGS_FIXTURE = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  quality: {
    baselines: {
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    },
  },
};

function fakeRefreshBaseline() {
  // Tests inject a stand-in for `refreshBaseline()` from the service. The
  // service is responsible for writing the merged envelope; the test stub
  // is a no-op because the git-add + diff-cached assertions are what we
  // actually want to pin.
  let calls = 0;
  const refreshBaseline = async (args) => {
    calls += 1;
    return { kind: args.kind, writePath: args.writePath, wrote: true };
  };
  refreshBaseline.callCount = () => calls;
  return refreshBaseline;
}

function fakeScorerBuilder() {
  return () => async () => []; // scorer is never invoked through the stub.
}

describe('runRefreshCommit — Story #2205 commit-hygiene contract', () => {
  it('runs refreshBaseline, stages, sees drift, and emits chore(baselines): commit', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner, calls } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1, // drift present
        stdout: 'M baselines/maintainability.json\n',
      },
      'commit -m chore(baselines): refresh maintainability for story-1124': {
        status: 0,
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'feed4242' },
    });
    const cycleState = { refreshedKinds: new Set(), lastRefreshSha: null };
    const result = await runRefreshCommit({
      cwd: '/repo',
      kind: 'maintainability',
      storyId: 1124,
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      cycleState,
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sha, 'feed4242');
    assert.equal(refreshBaseline.callCount(), 1);
    // Commit subject MUST be the canonical chore(baselines): refresh ...
    const commitCall = calls.find(
      (c) => c.args[0] === 'commit' && c.args[1] === '-m',
    );
    assert.ok(commitCall, 'commit must run');
    assert.equal(
      commitCall.args[2],
      'chore(baselines): refresh maintainability for story-1124',
    );
    // No --amend, no --allow-empty.
    const forbidden = calls.find(
      (c) =>
        c.args[0] === 'commit' &&
        (c.args.includes('--amend') || c.args.includes('--allow-empty')),
    );
    assert.equal(forbidden, undefined, 'must not amend or allow-empty');
    // Idempotency token registered.
    assert.equal(cycleState.refreshedKinds.has('maintainability'), true);
    assert.equal(cycleState.lastRefreshSha, 'feed4242');
  });

  it('skips with no-baseline-drift when staged tree matches HEAD (empty diff)', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner, calls } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 0, // no drift
      },
    });
    const cycleState = { refreshedKinds: new Set(), lastRefreshSha: null };
    const result = await runRefreshCommit({
      cwd: '/repo',
      kind: 'maintainability',
      storyId: 1124,
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      cycleState,
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-baseline-drift');
    // No commit fired.
    assert.equal(
      calls.find((c) => c.args[0] === 'commit'),
      undefined,
    );
    // Idempotency token still registered — a second call this cycle must
    // skip on the token.
    assert.equal(cycleState.refreshedKinds.has('maintainability'), true);
  });

  it('short-circuits via idempotency-token on a second invocation in the same cycle', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner, calls } = makeRecordingGit();
    const cycleState = {
      refreshedKinds: new Set(['maintainability']),
      lastRefreshSha: 'feed4242',
    };
    const result = await runRefreshCommit({
      cwd: '/repo',
      kind: 'maintainability',
      storyId: 1124,
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      cycleState,
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'idempotency-token');
    assert.equal(result.sha, 'feed4242');
    // Service was NOT invoked — the idempotency token gates the whole flow.
    assert.equal(refreshBaseline.callCount(), 0);
    assert.equal(calls.length, 0);
  });

  it('surfaces ok:false when git commit itself fails', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
        stdout: 'drift\n',
      },
      'commit -m chore(baselines): refresh maintainability for story-1124': {
        status: 1,
        stderr: 'nothing to commit',
      },
    });
    const result = await runRefreshCommit({
      cwd: '/repo',
      kind: 'maintainability',
      storyId: 1124,
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      cycleState: { refreshedKinds: new Set() },
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      gitRunner,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /git commit failed/);
  });

  it('returns ok:false when no baseline path is configured for the kind', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner } = makeRecordingGit();
    const result = await runRefreshCommit({
      cwd: '/repo',
      kind: 'maintainability',
      storyId: 1124,
      epicBranch: 'epic/1114',
      storyBranch: 'story-1124',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      cycleState: { refreshedKinds: new Set() },
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      // Inject a stub resolver that returns an empty baselines block so
      // the helper can verify its "no baseline path" guard fires.
      getBaselines: () => ({}),
      gitRunner,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no baseline path/);
  });
});

describe('stageAndCheckBaselineDrift — git add + diff-cached primitive', () => {
  it('returns hasDrift:true when diff --cached exits 1 (drift present)', () => {
    const { gitRunner } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
      },
    });
    const result = stageAndCheckBaselineDrift({
      cwd: '/repo',
      baselineFile: 'baselines/maintainability.json',
      gitRunner,
    });
    assert.deepEqual(result, { hasDrift: true });
  });

  it('returns hasDrift:false when diff --cached exits 0 (no drift)', () => {
    const { gitRunner } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 0,
      },
    });
    const result = stageAndCheckBaselineDrift({
      cwd: '/repo',
      baselineFile: 'baselines/maintainability.json',
      gitRunner,
    });
    assert.deepEqual(result, { hasDrift: false });
  });

  it('returns an error when git add fails', () => {
    const { gitRunner } = makeRecordingGit({
      'add baselines/maintainability.json': {
        status: 1,
        stderr: 'permission denied',
      },
    });
    const result = stageAndCheckBaselineDrift({
      cwd: '/repo',
      baselineFile: 'baselines/maintainability.json',
      gitRunner,
    });
    assert.ok(result.error);
    assert.match(result.error, /git add/);
  });

  it('returns an error when git diff --cached fails with an unexpected status', () => {
    const { gitRunner } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 128,
        stderr: 'corrupt index',
      },
    });
    const result = stageAndCheckBaselineDrift({
      cwd: '/repo',
      baselineFile: 'baselines/maintainability.json',
      gitRunner,
    });
    assert.ok(result.error);
    assert.match(result.error, /diff --cached/);
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

  it('all-attributable rows → runs refreshBaseline + commit and returns refreshed', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1114...story-1124': {
        status: 0,
        stdout: 'lib/touched.js\n',
      },
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
      },
      'commit -m chore(baselines): refresh maintainability for story-1124': {
        status: 0,
      },
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
      agentSettings: AGENT_SETTINGS_FIXTURE,
      provider: {},
      cycleState: { refreshedKinds: new Set(), lastRefreshSha: null },
      deps: {
        gitRunner,
        refreshBaseline,
        scorerBuilder: fakeScorerBuilder(),
      },
    });
    assert.equal(result.action, 'refreshed');
    assert.equal(result.sha, 'feed1234');
    assert.equal(refreshBaseline.callCount(), 1);
  });

  it('mixed rows with non-attributable present → posts friction, returns blocked, no auto-commit', async () => {
    const refreshBaseline = fakeRefreshBaseline();
    const { gitRunner, calls } = makeRecordingGit({
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
      agentSettings: AGENT_SETTINGS_FIXTURE,
      provider: {},
      cycleState: { refreshedKinds: new Set() },
      deps: {
        gitRunner,
        refreshBaseline,
        scorerBuilder: fakeScorerBuilder(),
        upsertStructuredComment,
      },
    });
    assert.equal(result.action, 'blocked');
    assert.equal(result.nonAttributable.length, 1);
    assert.equal(result.nonAttributable[0].path, 'lib/sibling.js');
    assert.equal(result.nonAttributable[0].suspectStoryNumber, 777);
    assert.equal(result.commentId, 42);
    // refreshBaseline must NOT fire on the blocked path.
    assert.equal(refreshBaseline.callCount(), 0);
    // No commit was issued.
    assert.equal(
      calls.find((c) => c.args[0] === 'commit'),
      undefined,
    );
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
        throw new Error(
          'Pre-merge validation failed at "check-maintainability" (exit 1) in /repo.',
        );
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
