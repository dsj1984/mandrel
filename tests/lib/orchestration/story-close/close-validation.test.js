import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCloseValidation } from '../../../../.agents/scripts/lib/close-validation.js';
import { runPreMergeGates } from '../../../../.agents/scripts/lib/orchestration/story-close/pre-merge-validation.js';

/**
 * Story #1120 — close-validation gate spawn locality.
 *
 * The acceptance criterion is "every gate invocation in close-validation.js
 * receives `{ cwd: worktreePath }` in its spawn options". These tests pin
 * that contract via an injected `runner` (the spawn seam) so we don't need
 * to actually fork a subprocess.
 */

function makeRecordingRunner() {
  const calls = [];
  const runner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0 };
  };
  return { runner, calls };
}

function makeFailingRunner({ failAt }) {
  const calls = [];
  const runner = (cmd, _args, opts) => {
    calls.push({ cmd, opts });
    return { status: cmd === failAt ? 2 : 0 };
  };
  return { runner, calls };
}

describe('runCloseValidation — worktree-locality (Story #1120)', () => {
  const fakeGates = [
    { name: 'lint', cmd: 'fake-lint', args: [] },
    { name: 'test', cmd: 'fake-test', args: [] },
    { name: 'format', cmd: 'fake-fmt', args: [] },
    { name: 'check-maintainability', cmd: 'fake-mi', args: [] },
    { name: 'coverage-capture', cmd: 'fake-cov', args: [] },
    { name: 'check-crap', cmd: 'fake-crap', args: [] },
  ];

  it('spawns every gate with cwd === worktreePath when supplied', () => {
    const { runner, calls } = makeRecordingRunner();
    const result = runCloseValidation({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-1120',
      gates: fakeGates,
      runner,
      useEvidence: false,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, fakeGates.length);
    for (const call of calls) {
      assert.equal(
        call.opts.cwd,
        '/main/repo/.worktrees/story-1120',
        `gate spawn for ${call.cmd} must run in the worktree, not the main checkout`,
      );
    }
  });

  it('falls back to cwd when worktreePath is omitted (legacy single-tree)', () => {
    const { runner, calls } = makeRecordingRunner();
    runCloseValidation({
      cwd: '/main/repo',
      gates: fakeGates,
      runner,
      useEvidence: false,
    });
    for (const call of calls) {
      assert.equal(call.opts.cwd, '/main/repo');
    }
  });

  it('failure record carries the spawn cwd so operators can locate the failing tree', () => {
    const { runner } = makeFailingRunner({ failAt: 'fake-test' });
    const messages = [];
    const result = runCloseValidation({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-1120',
      gates: fakeGates,
      runner,
      log: (m) => messages.push(m),
      useEvidence: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(
      result.failed[0].cwd,
      '/main/repo/.worktrees/story-1120',
      'failed record must include the spawn cwd',
    );
    const failureLine = messages.find((m) => m.includes('failed'));
    assert.ok(
      failureLine.includes('/main/repo/.worktrees/story-1120'),
      `failure log line must name the worktree path, got: ${failureLine}`,
    );
  });

  it('reads HEAD from the worktree (not main) so evidence keys to the Story branch', () => {
    const headCalls = [];
    const getHeadSha = (cwd) => {
      headCalls.push(cwd);
      return 'abc1234deadbeef';
    };
    const shouldSkipCalls = [];
    const shouldSkip = (input, opts) => {
      shouldSkipCalls.push({ input, opts });
      return { skip: false };
    };
    const recordPassCalls = [];
    const recordPass = (input, opts) => {
      recordPassCalls.push({ input, opts });
    };
    const { runner } = makeRecordingRunner();
    runCloseValidation({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-1120',
      gates: [{ name: 'lint', cmd: 'fake-lint', args: [] }],
      runner,
      storyId: 1120,
      epicId: 1114,
      useEvidence: true,
      getHeadSha,
      shouldSkip,
      recordPass,
    });
    assert.deepEqual(
      headCalls,
      ['/main/repo/.worktrees/story-1120'],
      'HEAD-SHA must be read from the worktree',
    );
    // Evidence file location stays anchored to main `.git/`
    assert.equal(shouldSkipCalls[0].opts.cwd, '/main/repo');
    assert.equal(recordPassCalls[0].opts.cwd, '/main/repo');
  });
});

describe('runPreMergeGates — worktree thread-through', () => {
  it('passes worktreePath into runCloseValidation', () => {
    let observed = null;
    const fakeRunCloseValidation = (opts) => {
      observed = opts;
      return { ok: true, failed: [], skipped: [] };
    };
    runPreMergeGates({
      cwd: '/main/repo',
      worktreePath: '/main/repo/.worktrees/story-1120',
      settings: {},
      storyId: 1120,
      epicId: 1114,
      useEvidence: false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      buildDefaultGates: () => [{ name: 'lint', cmd: 'fake', args: [] }],
      runCloseValidation: fakeRunCloseValidation,
    });
    assert.equal(observed.cwd, '/main/repo');
    assert.equal(observed.worktreePath, '/main/repo/.worktrees/story-1120');
  });

  it('throws with the spawn cwd in the message when a gate fails in the worktree', () => {
    const fakeRunCloseValidation = () => ({
      ok: false,
      failed: [
        {
          gate: { name: 'lint', cmd: 'fake', args: [], hint: 'fix it' },
          status: 2,
          cwd: '/main/repo/.worktrees/story-1120',
        },
      ],
      skipped: [],
    });
    assert.throws(
      () =>
        runPreMergeGates({
          cwd: '/main/repo',
          worktreePath: '/main/repo/.worktrees/story-1120',
          settings: {},
          storyId: 1120,
          epicId: 1114,
          useEvidence: false,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          buildDefaultGates: () => [{ name: 'lint', cmd: 'fake', args: [] }],
          runCloseValidation: fakeRunCloseValidation,
        }),
      (err) =>
        err instanceof Error &&
        err.message.includes('lint') &&
        err.message.includes('.worktrees/story-1120') &&
        err.message.includes('fix it'),
    );
  });
});
