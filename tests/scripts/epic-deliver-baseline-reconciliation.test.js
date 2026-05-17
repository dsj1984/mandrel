/**
 * Story #1396 (Epic #1386). Pin the post-merge baseline-reconciliation
 * helper introduced in `epic-deliver-finalize.js`. Three behavioural
 * contracts under test:
 *
 *   1. Drift on the merged tree → exactly one `baseline-refresh: epic-<id>`
 *      commit, sha returned in the envelope, only the changed baseline
 *      paths staged (no `git add -A`).
 *   2. No drift → zero refresh commits, helper returns `committed: false`.
 *   3. Re-running on a partial epic-deliver run does NOT duplicate the
 *      refresh commit — both `regenerateMainFromTree` and the `git commit`
 *      no-op paths short-circuit to `committed: false`.
 *
 * Heavy DI: every git invocation is stubbed. The full `runEpicDeliverFinalize`
 * orchestration is exercised separately in `epic-deliver-finalize.test.js`;
 * this suite scopes to the new reconciliation seam so failures pinpoint the
 * Tech-Spec contract for Epic #1386 (§ "/epic-deliver merge step").
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  reconcileBaselinesOnEpicBranch,
  runEpicDeliverFinalize,
} from '../../.agents/scripts/epic-deliver-finalize.js';

function silentLogger() {
  return {
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
    error: mock.fn(() => {}),
  };
}

function makeRouter(routes) {
  const calls = [];
  const fn = (_cwd, ...args) => {
    calls.push(args);
    for (const route of routes) {
      if (route.matcher(args)) {
        return {
          status: route.response.status ?? 0,
          stdout: route.response.stdout ?? '',
          stderr: route.response.stderr ?? '',
        };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { fn, calls };
}

describe('reconcileBaselinesOnEpicBranch — Story #1396 contract', () => {
  it('produces exactly one `baseline-refresh: epic-<id>` commit when scoring drifts', async () => {
    const regenerate = mock.fn(async () => ({
      didChange: true,
      files: [
        {
          kind: 'maintainability',
          path: '/repo/baselines/maintainability.json',
          didChange: true,
          reason: 'updated',
        },
        {
          kind: 'crap',
          path: '/repo/baselines/crap.json',
          didChange: true,
          reason: 'updated',
        },
      ],
    }));
    const { fn: gitSpawnFn, calls } = makeRouter([
      // `git rev-parse HEAD` after the commit lands.
      {
        matcher: (args) => args[0] === 'rev-parse' && args[1] === 'HEAD',
        response: { status: 0, stdout: 'cafef00dabc1234' },
      },
    ]);

    const out = await reconcileBaselinesOnEpicBranch({
      epicId: 1386,
      cwd: '/repo',
      logger: silentLogger(),
      regenerateMainFromTree: regenerate,
      gitSpawnFn,
    });

    assert.equal(out.committed, true);
    assert.equal(out.didChange, true);
    assert.equal(out.sha, 'cafef00dabc1234');

    // Verify the staging shape: two `git add -- <path>` calls + one
    // `git commit -m "baseline-refresh: epic-1386"`.
    const adds = calls.filter((c) => c[0] === 'add');
    assert.equal(adds.length, 2, 'must add both updated baseline paths');
    assert.deepEqual(
      adds.map((c) => c[c.length - 1]),
      ['/repo/baselines/maintainability.json', '/repo/baselines/crap.json'],
    );
    const commits = calls.filter((c) => c[0] === 'commit');
    assert.equal(commits.length, 1, 'must produce exactly one refresh commit');
    assert.equal(commits[0][1], '-m');
    assert.equal(commits[0][2], 'baseline-refresh: epic-1386');
  });

  it('produces zero refresh commits when scoring is unchanged', async () => {
    const regenerate = mock.fn(async () => ({
      didChange: false,
      files: [
        {
          kind: 'maintainability',
          path: '/repo/baselines/maintainability.json',
          didChange: false,
          reason: 'unchanged',
        },
      ],
    }));
    const { fn: gitSpawnFn, calls } = makeRouter([]);

    const out = await reconcileBaselinesOnEpicBranch({
      epicId: 99,
      cwd: '/repo',
      logger: silentLogger(),
      regenerateMainFromTree: regenerate,
      gitSpawnFn,
    });

    assert.equal(out.committed, false);
    assert.equal(out.didChange, false);
    assert.equal(out.reason, 'no-change');
    assert.equal(
      calls.length,
      0,
      'no git operations when regenerator reports no drift',
    );
  });

  it('treats a "nothing to commit" git failure as no-change (idempotent re-run)', async () => {
    // Simulates the partial-rerun path: regenerateMainFromTree wrote bytes
    // identical to the on-disk content (e.g., the prior refresh commit is
    // already on the Epic branch). `git add` succeeds, `git commit` exits
    // non-zero with "nothing to commit". The helper must NOT propagate this
    // as a failure — it must return committed:false / no-change.
    const regenerate = mock.fn(async () => ({
      didChange: true,
      files: [
        {
          kind: 'maintainability',
          path: '/repo/baselines/maintainability.json',
          didChange: true,
        },
      ],
    }));
    const { fn: gitSpawnFn } = makeRouter([
      { matcher: (args) => args[0] === 'add', response: { status: 0 } },
      {
        matcher: (args) => args[0] === 'commit',
        response: {
          status: 1,
          stderr: 'nothing to commit, working tree clean',
        },
      },
    ]);

    const out = await reconcileBaselinesOnEpicBranch({
      epicId: 5,
      cwd: '/repo',
      logger: silentLogger(),
      regenerateMainFromTree: regenerate,
      gitSpawnFn,
    });
    assert.equal(out.committed, false);
    assert.equal(out.reason, 'no-change');
  });

  it('catches a regenerator throw and returns reason:error (non-fatal)', async () => {
    const regenerate = mock.fn(async () => {
      throw new Error('escomplex parse error');
    });
    const { fn: gitSpawnFn, calls } = makeRouter([]);
    const logger = silentLogger();
    const out = await reconcileBaselinesOnEpicBranch({
      epicId: 1,
      cwd: '/repo',
      logger,
      regenerateMainFromTree: regenerate,
      gitSpawnFn,
    });
    assert.equal(out.committed, false);
    assert.equal(out.reason, 'error');
    assert.equal(calls.length, 0, 'no git operations after regenerator throws');
    assert.equal(logger.warn.mock.callCount(), 1);
  });

  it('returns reason:commit-failed when git commit fails for an unrecognised reason', async () => {
    const regenerate = mock.fn(async () => ({
      didChange: true,
      files: [
        {
          kind: 'crap',
          path: '/repo/baselines/crap.json',
          didChange: true,
        },
      ],
    }));
    const { fn: gitSpawnFn } = makeRouter([
      { matcher: (args) => args[0] === 'add', response: { status: 0 } },
      {
        matcher: (args) => args[0] === 'commit',
        response: { status: 1, stderr: 'pre-commit hook rejected' },
      },
    ]);
    const out = await reconcileBaselinesOnEpicBranch({
      epicId: 7,
      cwd: '/repo',
      logger: silentLogger(),
      regenerateMainFromTree: regenerate,
      gitSpawnFn,
    });
    assert.equal(out.committed, false);
    assert.equal(out.reason, 'commit-failed');
    assert.match(out.detail, /pre-commit hook rejected/);
  });
});

describe('runEpicDeliverFinalize — Story #1396 reconciliation wiring', () => {
  it('invokes reconcileBaselinesFn after FF check and surfaces the result on the envelope', async () => {
    const reconcileMock = mock.fn(async () => ({
      committed: true,
      didChange: true,
      sha: 'aabbcc',
    }));

    const { fn: gitSpawnFn } = makeRouter([
      {
        matcher: (args) =>
          args[0] === 'merge-base' && args[1] === '--is-ancestor',
        response: { status: 0 },
      },
      {
        matcher: (args) => args[0] === 'rev-list' && args[1] === '--count',
        response: { status: 0, stdout: '3' },
      },
      {
        matcher: (args) => args[0] === 'fetch',
        response: { status: 0 },
      },
      {
        matcher: (args) => args[0] === 'push',
        response: { status: 0 },
      },
    ]);

    const ghSpawnFn = mock.fn(() => ({
      status: 0,
      stdout: 'https://github.com/x/y/pull/42',
      stderr: '',
    }));

    const provider = {
      getTicket: async () => ({
        id: 1386,
        title: 'Epic — Stabilize',
        labels: ['acceptance::n-a'],
      }),
    };

    const upsertCommentFn = mock.fn(async () => ({}));
    const notifyFn = mock.fn(async () => ({}));

    const out = await runEpicDeliverFinalize({
      epicId: 1386,
      cwd: '/repo',
      injectedConfig: {
        agentSettings: { baseBranch: 'main' },
        orchestration: {},
      },
      injectedProvider: provider,
      loggerImpl: silentLogger(),
      gitSpawnFn,
      ghSpawnFn,
      upsertCommentFn,
      notifyFn,
      reconcileBaselinesFn: reconcileMock,
    });

    assert.equal(reconcileMock.mock.callCount(), 1);
    const arg = reconcileMock.mock.calls[0].arguments[0];
    assert.equal(arg.epicId, 1386);
    assert.equal(arg.cwd, '/repo');
    assert.equal(out.reconcile.committed, true);
    assert.equal(out.reconcile.sha, 'aabbcc');
  });
});
