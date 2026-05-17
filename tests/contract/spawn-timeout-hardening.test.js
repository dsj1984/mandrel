/**
 * Contract — Story #2165.
 *
 * Pins the bounded-timeout contract for the two close-time spawns that
 * were previously unbounded:
 *
 *   1. `format-autofix.js` — runs `npx biome format --write .` before the
 *      pre-merge gate chain. A deadlocked formatter plugin previously
 *      hung story-close indefinitely.
 *   2. `baseline-attribution-wiring.js → runRefreshCommit` — runs `npm
 *      run maintainability:update` / `npm run crap:update` when the
 *      attribution classifier decides drift is fully attributable. An
 *      infinite-loop refresh script previously hung story-close
 *      indefinitely.
 *
 * Regression boundary. Both spawns must:
 *
 *   - accept a `timeoutMs` (positive integer) and pass `killSignal:
 *     'SIGKILL'` to spawnSync so the watchdog fires deterministically;
 *   - translate a SIGKILL into the GNU `timeout(1)` convention exit code
 *     124 in their structured return envelope, so the orchestrator can
 *     branch on hang-vs-non-zero without inspecting signal names;
 *   - surface a `timedOut: true` flag so the close orchestrator routes
 *     the outcome to `agent::blocked` + a friction comment naming the
 *     failed spawn, rather than retrying.
 *
 * Both assertions exercise the helpers via injected spawn seams — no
 * real child process is created. A synthetic spawn that returns
 * `{ status: null, signal: 'SIGKILL' }` simulates the watchdog trip
 * within the test's wall clock.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REFRESH_TIMEOUT_EXIT_CODE,
  runRefreshCommit,
} from '../../.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js';
import {
  FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE,
  runFormatAutofix,
} from '../../.agents/scripts/lib/orchestration/story-close/format-autofix.js';

describe('format-autofix bounded timeout (Story #2165)', () => {
  it('threads a positive timeoutMs as `timeout` + killSignal: SIGKILL', () => {
    const spawnCalls = [];
    // execFileSync semantics: throw on non-zero exit. Here the test
    // succeeds (no throw) so we just record the opts. `gitSync` returns
    // empty status so the autofix path treats the tree as clean both
    // before and after the spawn.
    const spawn = (cmd, args, opts) => {
      if (cmd === 'git' || cmd === 'git.exe') return '';
      spawnCalls.push({ cmd, args, opts });
      return '';
    };
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 2165,
      timeoutMs: 60_000,
      logger: { info: () => {}, warn: () => {} },
      spawnSync: spawn,
      gitSync: () => '',
    });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].opts.timeout, 60_000);
    assert.equal(spawnCalls[0].opts.killSignal, 'SIGKILL');
    assert.equal(result.ran, true);
    assert.equal(result.timedOut, undefined);
  });

  it('returns the 124 envelope when the formatter spawn is killed by SIGKILL', () => {
    // execFileSync throws `Error` with `signal: 'SIGKILL'` and
    // `status: null` when the timeout watchdog fires. Replay that
    // exact shape synthetically so the test does not depend on Node's
    // internal timer.
    const synthHang = () => {
      const err = new Error('spawn killed by SIGKILL');
      err.signal = 'SIGKILL';
      err.status = null;
      throw err;
    };
    const warns = [];
    const result = runFormatAutofix({
      cwd: '/tmp/repo',
      storyId: 2165,
      timeoutMs: 100,
      logger: { info: () => {}, warn: (m) => warns.push(m) },
      spawnSync: synthHang,
      gitSync: () => '',
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE);
    assert.equal(FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE, 124);
    assert.equal(result.timeoutMs, 100);
    assert.equal(result.committed, false);
    assert.match(result.writeCmdString, /biome format --write/);
    assert.ok(
      warns.some((m) => /exceeded 100ms/.test(m)),
      'expected a timeout-trip warn log',
    );
  });
});

describe('baseline-refresh bounded timeout (Story #2165)', () => {
  it('threads a positive refreshTimeoutMs as `timeout` + killSignal: SIGKILL', () => {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    };
    // `runRefreshCommit` checks `git status --porcelain` after the
    // refresh; return non-empty to skip the "no-diff" failure branch.
    const gitRunner = {
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'status') {
          return { status: 0, stdout: ' M baselines/maintainability.json\n' };
        }
        if (args[0] === 'log') {
          return { status: 0, stdout: 'feat: previous commit\n' };
        }
        if (args[0] === 'rev-parse') {
          return { status: 0, stdout: 'abcdef1\n' };
        }
        return { status: 0, stdout: '' };
      },
    };
    const result = runRefreshCommit({
      cwd: '/tmp/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
      refreshSubject: 'baseline-refresh: maintainability',
      refreshTimeoutMs: 60_000,
      spawnSync: spawn,
      gitRunner,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['run', 'maintainability:update']);
    assert.equal(calls[0].opts.timeout, 60_000);
    assert.equal(calls[0].opts.killSignal, 'SIGKILL');
    assert.equal(result.ok, true);
  });

  it('returns the 124 envelope when the refresh spawn is killed by SIGKILL', () => {
    // node:child_process.spawnSync returns `{ status: null, signal:
    // 'SIGKILL', ... }` when the timeout watchdog kills the child. The
    // refresh helper inspects `result.signal` directly (no throw
    // contract), so we replay that shape via the injected runner.
    const synthHangSpawn = () => ({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
    });
    const warns = [];
    const result = runRefreshCommit({
      cwd: '/tmp/repo',
      refreshCmd: { cmd: 'npm', args: ['run', 'crap:update'] },
      refreshSubject: 'baseline-refresh: crap',
      refreshTimeoutMs: 200,
      spawnSync: synthHangSpawn,
      gitRunner: { gitSpawn: () => ({ status: 0, stdout: '' }) },
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, REFRESH_TIMEOUT_EXIT_CODE);
    assert.equal(REFRESH_TIMEOUT_EXIT_CODE, 124);
    assert.equal(result.timeoutMs, 200);
    assert.equal(result.spawnCmd, 'npm run crap:update');
    assert.ok(
      warns.some((m) => /exceeded 200ms/.test(m)),
      'expected a timeout-trip warn log',
    );
  });
});
