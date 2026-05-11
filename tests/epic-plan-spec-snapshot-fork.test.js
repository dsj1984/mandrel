import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { forkAndCommitEpicSnapshot } from '../.agents/scripts/epic-plan-spec.js';

/**
 * Story #1396 (Epic #1386). Verifies the snapshot-fork wiring inside
 * `epic-plan-spec.js`'s Phase 1 persistence step. The full `runSpecPhase`
 * orchestrator goes through ticket I/O and the planner pipeline; this suite
 * intentionally pins the smaller `forkAndCommitEpicSnapshot` seam introduced
 * for testability so it asserts:
 *
 *   - On a fresh Epic the snapshot files are forked + committed exactly once.
 *   - Re-running with `--force` (i.e., re-invoking the helper) re-forks from
 *     the current main baselines without throwing.
 *   - When the source baselines are missing, the helper does NOT fail the
 *     spec phase — it returns a `no-files`/`source-missing`-flavoured result
 *     so the caller can downgrade to `--full-scope`.
 */

function silentLogger() {
  return {
    info: mock.fn(() => {}),
    warn: mock.fn(() => {}),
    error: mock.fn(() => {}),
  };
}

describe('forkAndCommitEpicSnapshot — Story #1396 spec-phase wiring', () => {
  it('writes both snapshots and commits them on the Epic branch on first run', () => {
    const ensureRef = mock.fn(() => {});
    const fork = mock.fn(() => ({
      epicId: 1386,
      results: [
        {
          kind: 'maintainability',
          source: '/repo/baselines/maintainability.json',
          destination: '/repo/baselines/epic/1386/maintainability.json',
          written: true,
          reason: 'fresh',
        },
        {
          kind: 'crap',
          source: '/repo/baselines/crap.json',
          destination: '/repo/baselines/epic/1386/crap.json',
          written: true,
          reason: 'fresh',
        },
      ],
    }));
    const commit = mock.fn(() => ({ committed: true, sha: 'abc1234' }));
    const out = forkAndCommitEpicSnapshot({
      epicId: 1386,
      cwd: '/repo',
      logger: silentLogger(),
      forkFn: fork,
      commitFn: commit,
      ensureEpicBranchRefFn: ensureRef,
    });
    assert.equal(ensureRef.mock.callCount(), 1);
    assert.deepEqual(ensureRef.mock.calls[0].arguments.slice(0, 3), [
      'epic/1386',
      'main',
      '/repo',
    ]);
    assert.equal(fork.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 1);
    const commitCall = commit.mock.calls[0].arguments[0];
    assert.equal(commitCall.epicId, 1386);
    assert.equal(commitCall.epicBranch, 'epic/1386');
    assert.equal(commitCall.files.length, 2);
    assert.equal(out.commit.committed, true);
    assert.equal(out.commit.sha, 'abc1234');
  });

  it('on --force re-fork: re-invocation produces a fresh fork call (no caching at the seam)', () => {
    const fork = mock.fn(() => ({
      epicId: 7,
      results: [
        {
          kind: 'maintainability',
          source: '/repo/baselines/maintainability.json',
          destination: '/repo/baselines/epic/7/maintainability.json',
          written: true,
          reason: 'fresh',
        },
      ],
    }));
    const commit = mock.fn(() => ({ committed: true, sha: 'def5678' }));
    const ensureRef = mock.fn(() => {});

    forkAndCommitEpicSnapshot({
      epicId: 7,
      cwd: '/repo',
      logger: silentLogger(),
      forkFn: fork,
      commitFn: commit,
      ensureEpicBranchRefFn: ensureRef,
    });
    forkAndCommitEpicSnapshot({
      epicId: 7,
      cwd: '/repo',
      logger: silentLogger(),
      forkFn: fork,
      commitFn: commit,
      ensureEpicBranchRefFn: ensureRef,
    });
    assert.equal(
      fork.mock.callCount(),
      2,
      'fork must be re-invoked on every call',
    );
    assert.equal(
      commit.mock.callCount(),
      2,
      'commit must be re-invoked on every call',
    );
  });

  it('when source baselines are missing the spec phase still proceeds (no throw)', () => {
    const fork = mock.fn(() => ({
      epicId: 99,
      results: [
        {
          kind: 'maintainability',
          source: '/repo/baselines/maintainability.json',
          destination: '/repo/baselines/epic/99/maintainability.json',
          written: false,
          reason: 'source-missing',
        },
        {
          kind: 'crap',
          source: '/repo/baselines/crap.json',
          destination: '/repo/baselines/epic/99/crap.json',
          written: false,
          reason: 'source-missing',
        },
      ],
    }));
    const commit = mock.fn(() => ({ committed: false, reason: 'no-files' }));
    const ensureRef = mock.fn(() => {});

    const out = forkAndCommitEpicSnapshot({
      epicId: 99,
      cwd: '/repo',
      logger: silentLogger(),
      forkFn: fork,
      commitFn: commit,
      ensureEpicBranchRefFn: ensureRef,
    });
    // Commit helper sees zero candidate files (neither written nor idempotent).
    const commitCall = commit.mock.calls[0].arguments[0];
    assert.equal(commitCall.files.length, 0);
    assert.equal(out.commit.committed, false);
    assert.equal(out.commit.reason, 'no-files');
  });

  it('handles an unresolvable Epic branch ref non-fatally', () => {
    const ensureRef = mock.fn(() => {
      throw new Error('git error: cannot resolve epic ref');
    });
    const fork = mock.fn(() => ({ epicId: 1, results: [] }));
    const commit = mock.fn(() => ({ committed: false, reason: 'no-files' }));
    const logger = silentLogger();

    const out = forkAndCommitEpicSnapshot({
      epicId: 1,
      cwd: '/repo',
      logger,
      forkFn: fork,
      commitFn: commit,
      ensureEpicBranchRefFn: ensureRef,
    });
    assert.equal(
      fork.mock.callCount(),
      0,
      'fork must not fire when ensureRef throws',
    );
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(out.commit.committed, false);
    assert.equal(out.commit.reason, 'epic-missing');
    assert.equal(logger.warn.mock.callCount(), 1);
  });
});
