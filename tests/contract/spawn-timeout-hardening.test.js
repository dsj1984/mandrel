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
// Story #2205 — `runRefreshCommit` no longer spawns `npm run <kind>:update`,
// so the baseline-refresh timeout fixture is gone. `REFRESH_TIMEOUT_EXIT_CODE`
// stays exported as a historical constant; we no longer import it here.
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

// Story #2205 — the `baseline-refresh bounded timeout (Story #2165)`
// tests have been retired. `runRefreshCommit` no longer spawns
// `npm run <kind>:update`; the refresh runs in-process through
// `refreshBaseline()` (lib/baselines/refresh-service.js). The
// `REFRESH_TIMEOUT_EXIT_CODE` constant is still exported for callers
// (and tests) that referenced the historical contract, but the
// bounded-timeout wall no longer fires from this code path.
//
// The coverage-capture timeout test above retains its full Story #2136
// fixture coverage — that path still spawns and still tripwires on 124.
