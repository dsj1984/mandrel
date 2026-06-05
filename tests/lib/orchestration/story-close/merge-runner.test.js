/**
 * Direct branch coverage for the lock + push helpers in
 * `lib/orchestration/story-close/merge-runner.js`.
 *
 *   - lockPathDisplay        — pure path render.
 *   - withEpicMergeLock      — acquire success, acquire-failure throw with
 *                              operator-actionable lock-path message,
 *                              release-on-throw, log lines fired.
 *   - pushEpicAndHandleConflicts — happy path return, PushRetryConflictError
 *                                  → throw, finalize-mode retry-exhausted
 *                                  copy, finalize-mode generic copy,
 *                                  resume-mode copy via describeResumePushFailure.
 *   - emitBlockedCloseResult — canonical envelope builder; bus emit,
 *                              banner log, progress call, extra merge,
 *                              bus-null no-op.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  emitBlockedCloseResult,
  lockPathDisplay,
  pushEpicAndHandleConflicts,
  withEpicMergeLock,
} from '../../../../.agents/scripts/lib/orchestration/story-close/merge-runner.js';
import { PushRetryConflictError } from '../../../../.agents/scripts/lib/push-epic-retry.js';

describe('lockPathDisplay', () => {
  it('combines git-common-dir with epic-<id>.merge.lock', () => {
    const display = lockPathDisplay('/repo', 1);
    assert.equal(typeof display, 'string');
    assert.match(display, /epic-1\.merge\.lock$/);
  });
});

describe('withEpicMergeLock', () => {
  it('acquires, runs the body, releases, and returns the body result', async () => {
    const acquire = mock.fn(async () => ({ filePath: '/tmp/epic-1.lock' }));
    const release = mock.fn(() => {});
    const log = mock.fn(() => {});
    const result = await withEpicMergeLock(
      1,
      { repoRoot: '/repo', acquire, release, log },
      async (handle) => {
        assert.equal(handle.filePath, '/tmp/epic-1.lock');
        return 'ok';
      },
    );
    assert.equal(result, 'ok');
    assert.equal(acquire.mock.callCount(), 1);
    assert.equal(release.mock.callCount(), 1);
    // Two LOG events for acquire + release, plus the initial "Acquiring".
    assert.equal(log.mock.callCount(), 3);
  });

  it('releases even when the body throws', async () => {
    const release = mock.fn(() => {});
    await assert.rejects(
      () =>
        withEpicMergeLock(
          1,
          {
            repoRoot: '/repo',
            acquire: async () => ({ filePath: '/tmp/lock' }),
            release,
            log: () => {},
          },
          async () => {
            throw new Error('body fails');
          },
        ),
      /body fails/,
    );
    assert.equal(release.mock.callCount(), 1);
  });

  it('throws an operator-actionable error when acquire fails', async () => {
    await assert.rejects(
      () =>
        withEpicMergeLock(
          999_007,
          {
            repoRoot: '/repo',
            acquire: async () => {
              throw new Error('EBUSY');
            },
            release: () => {},
            log: () => {},
          },
          async () => 'never',
        ),
      (err) => {
        assert.match(
          err.message,
          /Could not acquire epic-merge lock for epic #999007/,
        );
        assert.match(err.message, /EBUSY/);
        // Operator-actionable: the message must reference the lock path.
        assert.match(err.message, /epic-999007\.merge\.lock/);
        return true;
      },
    );
  });
});

describe('pushEpicAndHandleConflicts — happy path', () => {
  it('returns the pushOutcome on success', async () => {
    const pushEpicWithRetry = mock.fn(async () => ({
      ok: true,
      attempts: 1,
      result: { stdout: 'pushed' },
    }));
    const out = await pushEpicAndHandleConflicts({
      cwd: '/repo',
      epicBranch: 'epic/1',
      storyBranch: 'story-100',
      orchestration: {},
      pushEpicWithRetry,
      getRunners: () => ({ storyMergeRetry: { maxAttempts: 3 } }),
    });
    assert.equal(out.ok, true);
    assert.equal(pushEpicWithRetry.mock.callCount(), 1);
  });
});

describe('pushEpicAndHandleConflicts — failure modes', () => {
  it('rethrows the PushRetryConflictError message inside an Error', async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          pushEpicWithRetry: async () => {
            throw new PushRetryConflictError(
              ['lib/x.js', 'lib/y.js'],
              'merge conflict in stderr',
            );
          },
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      /lib\/x\.js/,
    );
  });

  it('rethrows non-PushRetryConflictError errors verbatim', async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          pushEpicWithRetry: async () => {
            throw new Error('generic boom');
          },
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      /generic boom/,
    );
  });

  it('finalize mode: retry-exhausted reason produces the attempts-aware copy', async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          pushEpicWithRetry: async () => ({
            ok: false,
            attempts: 3,
            reason: 'retry-exhausted',
            result: { stderr: 'rejected' },
          }),
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      /retries exhausted after 3 attempt\(s\)\): rejected/,
    );
  });

  it('finalize mode: other reasons land in the generic copy', async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          pushEpicWithRetry: async () => ({
            ok: false,
            attempts: 1,
            reason: 'other-failure',
            result: { stderr: 'ssh denied' },
          }),
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      /Push failed \(other-failure\): ssh denied/,
    );
  });

  it('resume mode: routes generic failure through describeResumePushFailure', async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          mode: 'resume',
          pushEpicWithRetry: async () => ({
            ok: false,
            attempts: 1,
            reason: 'something-went-wrong',
            result: { stderr: 'auth' },
          }),
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      // The resume-mode helper produces operator-friendly copy; we just assert it threw.
      (err) => err instanceof Error && err.message.length > 0,
    );
  });

  it('falls back to result.stdout when stderr is empty in finalize mode', async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          pushEpicWithRetry: async () => ({
            ok: false,
            attempts: 1,
            reason: 'other',
            result: { stdout: 'fallback', stderr: '' },
          }),
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      /fallback/,
    );
  });

  it("falls back to 'unknown' when both stderr and stdout are empty", async () => {
    await assert.rejects(
      () =>
        pushEpicAndHandleConflicts({
          cwd: '/repo',
          epicBranch: 'epic/1',
          storyBranch: 'story-100',
          orchestration: {},
          pushEpicWithRetry: async () => ({
            ok: false,
            attempts: 1,
            reason: 'other',
            result: {},
          }),
          getRunners: () => ({ storyMergeRetry: {} }),
        }),
      /unknown/,
    );
  });
});

describe('emitBlockedCloseResult', () => {
  it('returns a blocked envelope with success:false, status:blocked, phase and reason', async () => {
    const progressCalls = [];
    const result = await emitBlockedCloseResult({
      storyId: 42,
      phase: 'closing',
      reason: 'baseline-drift-not-attributable',
      progress: (tag, msg) => progressCalls.push({ tag, msg }),
      blockedMessage: 'Story #42 blocked: drift on 3 path(s).',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.phase, 'closing');
    assert.equal(result.reason, 'baseline-drift-not-attributable');
    assert.equal(progressCalls.length, 1);
    assert.equal(progressCalls[0].tag, 'BLOCKED');
    assert.match(progressCalls[0].msg, /blocked: drift on 3 path/);
  });

  it('merges extra fields into the result envelope', async () => {
    const result = await emitBlockedCloseResult({
      storyId: 10,
      phase: 'preflight',
      reason: 'preflight-refused',
      extra: { findings: ['f1', 'f2'], exitCode: 2 },
      progress: () => {},
      blockedMessage: 'blocked',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.deepEqual(result.findings, ['f1', 'f2']);
    assert.equal(result.exitCode, 2);
  });

  it('emits story.blocked on the bus when bus is provided', async () => {
    const emitted = [];
    const bus = {
      emit: async (event, payload) => emitted.push({ event, payload }),
    };
    await emitBlockedCloseResult({
      storyId: 99,
      phase: 'closing',
      reason: 'push-failed:finalize',
      bus,
      progress: () => {},
      blockedMessage: 'blocked',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'story.blocked');
    assert.equal(emitted[0].payload.storyId, 99);
    assert.equal(emitted[0].payload.reason, 'push-failed:finalize');
  });

  it('skips the bus emit when bus is null', async () => {
    let emitCalled = false;
    // Providing bus: null means no emit — no error should be thrown.
    const result = await emitBlockedCloseResult({
      storyId: 7,
      phase: 'closing',
      reason: 'merge-conflict:major',
      bus: null,
      progress: () => {
        emitCalled = true;
      },
      blockedMessage: 'blocked',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.success, false);
    // progress was still called even when bus is null
    assert.ok(emitCalled);
  });

  it('logs the --- STORY CLOSE RESULT --- banner via the logger', async () => {
    const infoCalls = [];
    await emitBlockedCloseResult({
      storyId: 5,
      phase: 'closing',
      reason: 'code-review-critical',
      progress: () => {},
      blockedMessage: 'blocked',
      logger: { info: (m) => infoCalls.push(m), warn: () => {} },
    });
    assert.ok(infoCalls.some((m) => m.includes('--- STORY CLOSE RESULT ---')));
  });
});

// Sanity import — keeps `path` in use even if a future refactor drops the
// reliance from these tests.
void path;
