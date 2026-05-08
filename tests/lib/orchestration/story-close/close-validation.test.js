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

  it('spawns every gate with cwd === worktreePath when supplied', async () => {
    const { runner, calls } = makeRecordingRunner();
    const result = await runCloseValidation({
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

  it('falls back to cwd when worktreePath is omitted (legacy single-tree)', async () => {
    const { runner, calls } = makeRecordingRunner();
    await runCloseValidation({
      cwd: '/main/repo',
      gates: fakeGates,
      runner,
      useEvidence: false,
    });
    for (const call of calls) {
      assert.equal(call.opts.cwd, '/main/repo');
    }
  });

  it('failure record carries the spawn cwd so operators can locate the failing tree', async () => {
    const { runner } = makeFailingRunner({ failAt: 'fake-test' });
    const messages = [];
    const result = await runCloseValidation({
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

  it('reads HEAD from the worktree (not main) so evidence keys to the Story branch', async () => {
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
    await runCloseValidation({
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

describe('runCloseValidation — independent/serial split', () => {
  const gates = [
    { name: 'lint', cmd: 'fake-lint', args: [] },
    { name: 'format', cmd: 'fake-format', args: [] },
    { name: 'typecheck', cmd: 'fake-typecheck', args: [] },
    { name: 'test', cmd: 'fake-test', args: [] },
    { name: 'check-maintainability', cmd: 'fake-mi', args: [] },
  ];

  it('aborts in-flight independent siblings on first failure (only one error surfaces)', async () => {
    // All three independent gates start in parallel. lint exits non-zero
    // first; format and typecheck must observe the AbortSignal and stop.
    const events = [];
    let inFlight = 0;
    let inFlightPeak = 0;
    let lintReleased;
    const lintGate = new Promise((resolve) => {
      lintReleased = resolve;
    });
    let independentStarts = 0;

    const runner = async (cmd, _args, opts) => {
      events.push({ phase: 'start', cmd });
      inFlight += 1;
      inFlightPeak = Math.max(inFlightPeak, inFlight);
      try {
        if (
          cmd === 'fake-lint' ||
          cmd === 'fake-format' ||
          cmd === 'fake-typecheck'
        ) {
          independentStarts += 1;
          if (independentStarts === 3) lintReleased();
          if (cmd === 'fake-lint') {
            await lintGate;
            return { status: 2 };
          }
          // format / typecheck: wait until aborted, then surface non-zero.
          await new Promise((resolve) => {
            if (opts.signal.aborted) return resolve();
            opts.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return { status: 143 };
        }
        // Serial gates — should never run when an independent gate has failed.
        events.push({ phase: 'serial-ran', cmd });
        return { status: 0 };
      } finally {
        inFlight -= 1;
        events.push({ phase: 'end', cmd });
      }
    };

    const result = await runCloseValidation({
      cwd: '/repo',
      gates,
      runner,
      useEvidence: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1, 'only one error must surface');
    assert.equal(result.failed[0].gate.name, 'lint');
    assert.equal(result.failed[0].status, 2);
    assert.equal(
      inFlightPeak,
      3,
      'all three independent gates must run in parallel',
    );
    assert.ok(
      !events.some((e) => e.phase === 'serial-ran'),
      'serial gates must not run after an independent gate failed',
    );
  });

  it('runs serial gates strictly after every independent gate has finished', async () => {
    // Block independent gates until every one has been *started*. If serial
    // gates ran before independent gates resolved, we'd deadlock — and the
    // assertion at the end would never fire.
    const order = [];
    const independentNames = new Set([
      'fake-lint',
      'fake-format',
      'fake-typecheck',
    ]);
    let independentStarts = 0;
    let releaseIndependent;
    const independentGate = new Promise((resolve) => {
      releaseIndependent = resolve;
    });

    const runner = async (cmd) => {
      order.push({ cmd, at: 'start' });
      if (independentNames.has(cmd)) {
        independentStarts += 1;
        if (independentStarts === 3) releaseIndependent();
        await independentGate;
        order.push({ cmd, at: 'end' });
        return { status: 0 };
      }
      order.push({ cmd, at: 'end' });
      return { status: 0 };
    };

    const result = await runCloseValidation({
      cwd: '/repo',
      gates,
      runner,
      useEvidence: false,
    });

    assert.equal(result.ok, true);
    // Every independent gate must reach `end` before any serial gate reaches
    // `start`. Find the latest independent end-index and the earliest serial
    // start-index.
    const lastIndependentEnd = order
      .map((e, i) => (independentNames.has(e.cmd) && e.at === 'end' ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    const firstSerialStart = order.findIndex(
      (e) => !independentNames.has(e.cmd) && e.at === 'start',
    );
    assert.ok(
      lastIndependentEnd < firstSerialStart,
      `serial gates started before independent gates finished — order: ${JSON.stringify(order)}`,
    );
    // All three independent gates were active at once (i.e. none of them
    // ran serially before the others started).
    assert.equal(independentStarts, 3);
  });
});

describe('runPreMergeGates — worktree thread-through', () => {
  it('passes worktreePath into runCloseValidation', async () => {
    let observed = null;
    const fakeRunCloseValidation = (opts) => {
      observed = opts;
      return { ok: true, failed: [], skipped: [] };
    };
    await runPreMergeGates({
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

  it('throws with the spawn cwd in the message when a gate fails in the worktree', async () => {
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
    await assert.rejects(
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
