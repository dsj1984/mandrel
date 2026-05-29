/**
 * story-close-state-machine.test.js
 *
 * Story #2144 / Task #2155 — assert the `agent::closing` intermediate
 * state machine wired into `story-close`. Two scenarios:
 *
 *   1. Successful close: the Story's label sequence is exactly
 *      `executing → closing → done`. The `agent::done` transition is
 *      written by `runPostMergeClose`'s downstream pipeline, gated by
 *      the merge-reachability assertion.
 *
 *   2. Killed close (post-`closing`, pre-`done`): when
 *      `assertMergeReachable` throws, `runPostMergeClose` propagates
 *      the throw without invoking the post-merge pipeline — so the
 *      Story stays at `agent::closing` and a `--resume` can pick up at
 *      the post-merge phase rather than re-running preflight.
 *
 * Coverage of the validator-level invariants (`executing → closing →
 * done` allowed; `closing → executing` rejected) lives in
 * `tests/lib/label-constants.test.js`. This file pins the runtime
 * behaviour of `story-close.js` / `post-merge-close.js` themselves.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import {
  assertMergeReachable,
  runPostMergeClose,
} from '../.agents/scripts/lib/orchestration/story-close/post-merge-close.js';

/**
 * Build a `gitSpawn` test double keyed on argv. Returns scripted exit
 * envelopes (`{ status, stdout, stderr }`). Records every call so tests
 * can assert the two-phase reachability sequence (`rev-parse` →
 * `merge-base --is-ancestor` → optional `log --grep`) ran as expected.
 */
function makeGitSpawn(scripts) {
  const calls = [];
  function gitSpawn(_cwd, ...args) {
    const key = args.join(' ');
    calls.push(key);
    const next = scripts[key];
    if (!next) {
      throw new Error(`unexpected gitSpawn(${key})`);
    }
    return typeof next === 'function' ? next() : next;
  }
  return { gitSpawn, calls };
}

const REACHABLE_HEAD = 'abc1234abc1234abc1234abc1234abc1234abcd';

test('assertMergeReachable returns reachable when story HEAD is ancestor of epic branch', () => {
  const { gitSpawn, calls } = makeGitSpawn({
    'rev-parse story-100': {
      status: 0,
      stdout: `${REACHABLE_HEAD}\n`,
      stderr: '',
    },
    [`merge-base --is-ancestor ${REACHABLE_HEAD} epic/99`]: {
      status: 0,
      stdout: '',
      stderr: '',
    },
  });
  const result = assertMergeReachable({
    cwd: '/repo',
    storyBranch: 'story-100',
    epicBranch: 'epic/99',
    storyId: 100,
    gitSpawn,
  });
  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'head-reachable-from-epic');
  // No `log --grep` round-trip when the ancestor check succeeds.
  assert.deepEqual(calls, [
    'rev-parse story-100',
    `merge-base --is-ancestor ${REACHABLE_HEAD} epic/99`,
  ]);
});

test('assertMergeReachable falls back to merge-commit grep when ancestry fails', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse story-100': {
      status: 0,
      stdout: `${REACHABLE_HEAD}\n`,
      stderr: '',
    },
    [`merge-base --is-ancestor ${REACHABLE_HEAD} epic/99`]: {
      status: 1,
      stdout: '',
      stderr: '',
    },
    'log epic/99 --merges -n 1 --pretty=%H -E --grep=resolves #100( |\\)|$)': {
      status: 0,
      stdout: 'deadbee\n',
      stderr: '',
    },
  });
  const result = assertMergeReachable({
    cwd: '/repo',
    storyBranch: 'story-100',
    epicBranch: 'epic/99',
    storyId: 100,
    gitSpawn,
  });
  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'merge-commit-reachable');
});

test('assertMergeReachable falls back to rebased-equivalents when ancestry and merge-commit grep miss but cherry shows all patch-equivalent (Story #3161)', () => {
  // Recovery scenario from Story #3122: operator manually rebased the
  // Story's content onto `epic/<id>` so the diff is present as commits
  // with **different SHAs** and no `(resolves #<id>)` merge commit. The
  // ancestor check returns 1 (story tip's own commits are not ancestors)
  // and the grep returns empty, but `git cherry` reports every commit on
  // the Story branch as patch-equivalent to a commit already on the Epic.
  const { gitSpawn } = makeGitSpawn({
    'rev-parse story-100': {
      status: 0,
      stdout: `${REACHABLE_HEAD}\n`,
      stderr: '',
    },
    [`merge-base --is-ancestor ${REACHABLE_HEAD} epic/99`]: {
      status: 1,
      stdout: '',
      stderr: '',
    },
    'log epic/99 --merges -n 1 --pretty=%H -E --grep=resolves #100( |\\)|$)': {
      status: 0,
      stdout: '',
      stderr: '',
    },
    'cherry epic/99 story-100': {
      status: 0,
      stdout: '- aaaa1111\n- bbbb2222\n- cccc3333\n',
      stderr: '',
    },
  });
  const result = assertMergeReachable({
    cwd: '/repo',
    storyBranch: 'story-100',
    epicBranch: 'epic/99',
    storyId: 100,
    gitSpawn,
  });
  assert.equal(result.reachable, true);
  assert.equal(result.reason, 'rebased-equivalents');
});

test('assertMergeReachable throws when ancestry, merge-commit grep, and cherry all miss', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse story-100': {
      status: 0,
      stdout: `${REACHABLE_HEAD}\n`,
      stderr: '',
    },
    [`merge-base --is-ancestor ${REACHABLE_HEAD} epic/99`]: {
      status: 1,
      stdout: '',
      stderr: '',
    },
    'log epic/99 --merges -n 1 --pretty=%H -E --grep=resolves #100( |\\)|$)': {
      status: 0,
      stdout: '',
      stderr: '',
    },
    'cherry epic/99 story-100': {
      status: 0,
      stdout: '+ dddd4444\n',
      stderr: '',
    },
  });
  assert.throws(
    () =>
      assertMergeReachable({
        cwd: '/repo',
        storyBranch: 'story-100',
        epicBranch: 'epic/99',
        storyId: 100,
        gitSpawn,
      }),
    /merge verification failed for #100/,
  );
});

test('assertMergeReachable error message preserves agent::closing recovery contract', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse story-100': {
      status: 0,
      stdout: `${REACHABLE_HEAD}\n`,
      stderr: '',
    },
    [`merge-base --is-ancestor ${REACHABLE_HEAD} epic/99`]: {
      status: 1,
      stdout: '',
      stderr: '',
    },
    'log epic/99 --merges -n 1 --pretty=%H -E --grep=resolves #100( |\\)|$)': {
      status: 0,
      stdout: '',
      stderr: '',
    },
    'cherry epic/99 story-100': {
      status: 0,
      stdout: '+ dddd4444\n',
      stderr: '',
    },
  });
  try {
    assertMergeReachable({
      cwd: '/repo',
      storyBranch: 'story-100',
      epicBranch: 'epic/99',
      storyId: 100,
      gitSpawn,
    });
    assert.fail('expected throw');
  } catch (err) {
    // The operator-facing recovery hint MUST name `agent::closing` and
    // direct them to `--resume`; otherwise the killed-close path looks
    // identical to a hard failure and the dispatch loop will treat the
    // Story as failed rather than resumable.
    assert.match(err.message, /agent::closing/);
    assert.match(err.message, /--resume/);
  }
});

test('runPostMergeClose invokes the post-merge pipeline on a successful merge verification', async () => {
  let mergeAssertionCalled = false;
  let pipelineRan = false;
  const result = await runPostMergeClose({
    orchestration: {},
    storyId: 100,
    epicId: 99,
    story: { id: 100, title: 'demo' },
    storyBranch: 'story-100',
    epicBranch: 'epic/99',
    cwd: '/repo',
    projectRoot: '/repo',
    config: {},
    provider: {},
    notify: async () => {},
    tasks: [],
    skipDashboard: true,
    progress: () => {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    phaseTimer: { mark: () => {}, finish: () => ({}) },
    clearPhaseTimerState: () => {},
    // Stub the merge-reachability guard so the test does not need a real git tree.
    assertMergeReachableFn: () => {
      mergeAssertionCalled = true;
      return { reachable: true, reason: 'head-reachable-from-epic' };
    },
    runPostMergePipeline: async () => {
      pipelineRan = true;
      return {
        worktreeReap: { status: 'removed' },
        branchCleanup: { localDeleted: true, remoteDeleted: true },
        ticketClosure: {
          closedTickets: [100],
          cascadedTo: [],
          cascadeFailed: [],
        },
        manifestUpdated: true,
      };
    },
    drainPendingCleanupAfterClose: async () => ({}),
    reconcileCleanupState: ({ branchCleanup, worktreeReap }) => ({
      branchCleanup,
      worktreeReap,
    }),
    writeFileFn: async () => {},
    mkdirFn: async () => {},
    clearActiveStoryEnv: () => {},
    emitGhSpawnCount: async () => {},
  });
  assert.equal(mergeAssertionCalled, true);
  assert.equal(pipelineRan, true);
  assert.equal(result.merged, true);
  assert.equal(result.branchDeleted, true);
  // The `ticketClosurePhase` inside the pipeline is what writes
  // `agent::done`; observing `ticketsClosed` containing the Story id is
  // the proof the pipeline got to fire.
  assert.deepEqual(result.ticketsClosed, [100]);
});

test('runPostMergeClose throws (preserving agent::closing) when merge verification fails', async () => {
  let pipelineRan = false;
  await assert.rejects(
    runPostMergeClose({
      orchestration: {},
      storyId: 100,
      epicId: 99,
      story: { id: 100, title: 'demo' },
      storyBranch: 'story-100',
      epicBranch: 'epic/99',
      cwd: '/repo',
      projectRoot: '/repo',
      config: {},
      provider: {},
      notify: async () => {},
      tasks: [],
      skipDashboard: true,
      progress: () => {},
      logger: { warn: () => {}, error: () => {}, info: () => {} },
      phaseTimer: { mark: () => {}, finish: () => ({}) },
      clearPhaseTimerState: () => {},
      assertMergeReachableFn: () => {
        throw new Error(
          'story-close: merge verification failed for #100 — Story remains at `agent::closing`; re-run with `--resume`',
        );
      },
      runPostMergePipeline: async () => {
        pipelineRan = true;
        return {};
      },
      drainPendingCleanupAfterClose: async () => ({}),
      reconcileCleanupState: (input) => input,
      writeFileFn: async () => {},
      mkdirFn: async () => {},
      clearActiveStoryEnv: () => {},
      emitGhSpawnCount: async () => {},
    }),
    /merge verification failed for #100/,
  );
  // The post-merge pipeline (which is the single writer for
  // `agent::done`) MUST NOT have fired on a failed merge verification.
  assert.equal(
    pipelineRan,
    false,
    'pipeline ran despite failed merge verification — agent::done could leak past agent::closing',
  );
});
