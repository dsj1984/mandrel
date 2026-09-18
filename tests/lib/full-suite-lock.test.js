import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { defaultGateRunner } from '../../.agents/scripts/lib/close-validation/process.js';
import {
  FULL_SUITE_LOCK_ENV,
  FULL_SUITE_LOCK_EXPIRY_ENV,
  isFullSuiteLockEnabled,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
  lockedCapture,
  resolveFullSuiteLockPath,
  withFullSuiteLockAsync,
} from '../../.agents/scripts/lib/full-suite-lock.js';
import {
  dequeueWaiter,
  enqueueWaiter,
  isFirstInLine,
  parseLockWaitOutcome,
  refreshTicket,
} from '../../.agents/scripts/lib/full-suite-queue.js';
import { acquireSweepLock } from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * Story #5173 — the host-level full-suite lock.
 *
 * These drive the real lockfile on a real temp directory rather than a mocked
 * `fs`: the contract under test is cross-process mutual exclusion, and the
 * only honest way to assert "the second runner did not overlap the first" is
 * to have two acquirers contend on one file. The lock's *identity* mechanics
 * (pid+mtime, stale takeover, owner-checked release) belong to
 * `sweep-lock.js` and are pinned there; what is pinned here is this module's
 * own posture — best-effort, spawn exactly once, wait visibly, cover only the
 * spawn.
 */
describe('full-suite lock (Story #5173)', () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = makeTempDir('mandrel-fsl-');
    lockPath = path.join(dir, 'full-suite.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('isFullSuiteLockEnabled — AC-10, both escape hatches', () => {
    it('defaults on when neither hatch is set', () => {
      assert.equal(isFullSuiteLockEnabled({ config: {}, env: {} }), true);
      assert.equal(isFullSuiteLockEnabled({ env: {} }), true);
    });

    it('honours delivery.execution.fullSuiteLock: false', () => {
      const config = { delivery: { execution: { fullSuiteLock: false } } };
      assert.equal(isFullSuiteLockEnabled({ config, env: {} }), false);
    });

    it('honours MANDREL_FULL_SUITE_LOCK=0 and its spellings', () => {
      for (const raw of ['0', 'false', 'off', 'no', ' OFF ']) {
        assert.equal(
          isFullSuiteLockEnabled({
            config: {},
            env: { [FULL_SUITE_LOCK_ENV]: raw },
          }),
          false,
          `expected ${JSON.stringify(raw)} to disable the lock`,
        );
      }
    });

    it('is one-way: the env hatch cannot force the lock back on', () => {
      const config = { delivery: { execution: { fullSuiteLock: false } } };
      assert.equal(
        isFullSuiteLockEnabled({
          config,
          env: { [FULL_SUITE_LOCK_ENV]: '1' },
        }),
        false,
      );
    });

    // The key must resolve from the RUNTIME AJV delivery schema — a key
    // declared only in the generated JSON-Schema mirror never reaches config
    // resolution, so a mirror-only declaration would make this switch inert.
    it('AC-10: the key is declared in the runtime AJV delivery schema', async () => {
      const { AGENTRC_SCHEMA } = await import(
        '../../.agents/scripts/lib/config-settings-schema.js'
      );
      const execution =
        AGENTRC_SCHEMA.properties.delivery.properties.execution.properties;
      assert.deepEqual(execution.fullSuiteLock, {
        type: 'boolean',
        description: execution.fullSuiteLock.description,
        default: true,
      });
      assert.match(
        execution.fullSuiteLock.description,
        new RegExp(FULL_SUITE_LOCK_ENV),
        'the schema description must name the env escape hatch',
      );
    });
  });

  describe('resolveFullSuiteLockPath', () => {
    it('anchors on the main checkout so sibling worktrees share one file', () => {
      const fromWorktree = resolveFullSuiteLockPath({
        cwd: '/repo/.worktrees/story-1',
        mainCheckoutRootFn: () => '/repo',
      });
      const fromMain = resolveFullSuiteLockPath({
        cwd: '/repo',
        mainCheckoutRootFn: () => '/repo',
      });
      assert.equal(fromWorktree, fromMain);
      assert.equal(
        fromWorktree,
        path.join('/repo', '.git', 'mandrel-full-suite.lock'),
      );
    });

    it('returns null when the checkout root cannot be resolved', () => {
      assert.equal(
        resolveFullSuiteLockPath({
          cwd: '/nope',
          mainCheckoutRootFn: () => null,
        }),
        null,
      );
      assert.equal(resolveFullSuiteLockPath({ cwd: '' }), null);
    });
  });

  /**
   * A fake clock the wait loop advances through its own sleep seam, so a
   * five-minute wait runs in microseconds and its log lines are exact.
   */
  function fakeClock(onSleep = () => {}) {
    let now = 1_000_000;
    return {
      nowFn: () => now,
      sleepFn: async (ms) => {
        now += ms;
        onSleep(now);
      },
      advance: (ms) => {
        now += ms;
      },
    };
  }

  describe('withFullSuiteLockAsync', () => {
    it('runs the spawn and releases the lockfile on the uncontended path', async () => {
      let held = null;
      const result = await withFullSuiteLockAsync(
        { cwd: dir, lockPath },
        async () => {
          held = fs.existsSync(lockPath);
          return { status: 0 };
        },
      );
      assert.deepEqual(result, { status: 0 });
      assert.equal(held, true, 'the lock must be held across the spawn');
      assert.equal(fs.existsSync(lockPath), false, 'and released after it');
    });

    it('a contended runner spawns only after the holder releases', async () => {
      const order = [];
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      assert.equal(holder.acquired, true);
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          waitMs: 10_000,
          pollMs: 1,
          sleepFn: async () => {
            if (order.length === 0) {
              order.push('holder-release');
              holder.release();
            }
          },
        },
        async () => {
          order.push('spawn');
          return 0;
        },
      );
      assert.equal(code, 0);
      assert.deepEqual(order, ['holder-release', 'spawn']);
    });

    it('a wait names the holding pid and reports how long it waited', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      const lines = [];
      const clock = fakeClock((now) => {
        if (now >= 1_000_000 + 6_000) holder.release();
      });
      await withFullSuiteLockAsync(
        { cwd: dir, lockPath, log: (m) => lines.push(m), ...clock },
        async () => 0,
      );
      assert.match(lines[0], new RegExp(`holding pid ${process.pid}\\b`));
      assert.deepEqual(parseLockWaitOutcome(lines.at(-1)), {
        waitedSeconds: 6,
        expired: false,
      });
    });

    it('a stale holder is reclaimed rather than waited out', async () => {
      const holder = acquireSweepLock({
        lockPath,
        timeoutMs: 60_000,
        heartbeatMs: 0,
      });
      assert.equal(holder.acquired, true);
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(lockPath, old, old);
      let sleeps = 0;
      const lines = [];
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          staleMs: 1_000,
          sleepFn: async () => {
            sleeps += 1;
          },
          log: (m) => lines.push(m),
        },
        async () => 5,
      );
      assert.equal(code, 5);
      assert.equal(
        sleeps,
        0,
        'a stale lock must be taken over, never waited on',
      );
      assert.deepEqual(lines, [], 'and the takeover is silent');
    });

    it('is best-effort: an exhausted wait still spawns exactly once by default', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      let spawns = 0;
      const lines = [];
      const code = await withFullSuiteLockAsync(
        { cwd: dir, lockPath, waitMs: 0, log: (m) => lines.push(m) },
        async () => {
          spawns += 1;
          return 3;
        },
      );
      holder.release();
      assert.equal(code, 3);
      assert.equal(spawns, 1);
      assert.match(lines.at(-1), /spawning anyway/);
      assert.equal(parseLockWaitOutcome(lines.at(-1)).expired, true);
    });

    it('is best-effort: a hard acquire error still spawns exactly once', async () => {
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          acquireOnceFn: () => ({
            acquired: false,
            reason: 'error',
            detail: 'EACCES',
          }),
        },
        async () => {
          spawns += 1;
          return 0;
        },
      );
      assert.equal(code, 0);
      assert.equal(spawns, 1);
      assert.equal(fs.existsSync(lockPath), false);
    });

    it('a hard error mid-wait ends the wait without calling it an expiry', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      let calls = 0;
      let deferred = 0;
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          sleepFn: async () => {},
          acquireOnceFn: (opts) => {
            calls += 1;
            return calls === 1
              ? acquireSweepLock(opts)
              : { acquired: false, reason: 'error' };
          },
          onWaitExpired: () => {
            deferred += 1;
            return 75;
          },
        },
        async () => 0,
      );
      holder.release();
      assert.equal(code, 0, 'an I/O error spawns unserialized');
      assert.equal(deferred, 0);
    });

    it('disabled means no lockfile is ever created', async () => {
      const code = await withFullSuiteLockAsync(
        { cwd: dir, lockPath, enabled: false },
        async () => 0,
      );
      assert.equal(code, 0);
      assert.equal(fs.existsSync(lockPath), false);
    });

    it('never locks when the lock home cannot be resolved', async () => {
      let spawns = 0;
      await withFullSuiteLockAsync({ cwd: '' }, async () => {
        spawns += 1;
      });
      assert.equal(spawns, 1);
    });

    it('releases the lock even when the spawn throws', async () => {
      await assert.rejects(
        withFullSuiteLockAsync({ cwd: dir, lockPath }, async () => {
          throw new Error('suite blew up');
        }),
        /suite blew up/,
      );
      assert.equal(fs.existsSync(lockPath), false);
    });
  });

  describe('budgets (Story #5377)', () => {
    it('AC-5: the default wait expires at 300s, under the foreground ceiling', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      const lines = [];
      const clock = fakeClock();
      await withFullSuiteLockAsync(
        { cwd: dir, lockPath, log: (m) => lines.push(m), ...clock },
        async () => 0,
      );
      holder.release();
      const outcome = parseLockWaitOutcome(lines.at(-1));
      assert.equal(outcome.expired, true);
      assert.ok(
        outcome.waitedSeconds >= 298 && outcome.waitedSeconds <= 300,
        `expected a ~300s wait, got ${outcome.waitedSeconds}s`,
      );
    });

    it('AC-5: the default stale threshold does not exceed the wait budget', async () => {
      // A live pid that has not refreshed its lock for a full wait budget: a
      // stale threshold at or below that budget reclaims it at once.
      const holder = acquireSweepLock({
        lockPath,
        timeoutMs: 600_000,
        heartbeatMs: 0,
      });
      const aged = new Date(Date.now() - 301_000);
      fs.utimesSync(lockPath, aged, aged);
      let sleeps = 0;
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          sleepFn: async () => {
            sleeps += 1;
          },
        },
        async () => 0,
      );
      holder.release();
      assert.equal(code, 0);
      assert.equal(sleeps, 0);
    });
  });

  describe('arrival-order fairness (Story #5377)', () => {
    it('AC-6: of two waiters, the one that began waiting first acquires first', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      const order = [];
      let releaseHolder;
      const holderGone = new Promise((resolve) => {
        releaseHolder = resolve;
      });
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      // The earlier waiter polls slowly; the later one polls on every tick,
      // which is exactly the lucky-moment overtake the queue must refuse.
      const early = withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          pollMs: 0,
          sleepFn: async () => {
            await holderGone;
            for (let i = 0; i < 20; i += 1) await tick();
          },
        },
        async () => {
          order.push('early');
          await tick();
          return 0;
        },
      );
      await tick();
      const late = withFullSuiteLockAsync(
        { cwd: dir, lockPath, pollMs: 0, sleepFn: tick },
        async () => {
          order.push('late');
          return 0;
        },
      );
      for (let i = 0; i < 5; i += 1) await tick();
      holder.release();
      releaseHolder();
      await Promise.all([early, late]);
      assert.deepEqual(order, ['early', 'late']);
    });

    it('a newcomer does not take the free lock ahead of a live queued waiter', () => {
      const ticket = enqueueWaiter({ lockPath });
      try {
        assert.equal(
          isFirstInLine({ lockPath, ticket: null, staleMs: 60_000 }),
          false,
        );
        assert.equal(
          isFirstInLine({ lockPath, ticket, staleMs: 60_000 }),
          true,
        );
      } finally {
        dequeueWaiter(ticket);
      }
      assert.equal(
        isFirstInLine({ lockPath, ticket: null, staleMs: 60_000 }),
        true,
      );
    });

    it('a corrupt, dead-pid, or stale queue entry never holds a place in line', () => {
      const queueDir = `${lockPath}.queue`;
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, '000000000000001-garbage'), '');
      fs.writeFileSync(
        path.join(queueDir, '000000000000002-000001-999999999-ab'),
        '',
      );
      const stale = path.join(
        queueDir,
        `000000000000003-000001-${process.pid}-cd`,
      );
      fs.writeFileSync(stale, '');
      const aged = new Date(Date.now() - 120_000);
      fs.utimesSync(stale, aged, aged);
      assert.equal(
        isFirstInLine({
          lockPath,
          ticket: null,
          staleMs: 60_000,
          killFn: (pid) => {
            if (pid !== process.pid) {
              throw Object.assign(new Error('gone'), { code: 'ESRCH' });
            }
          },
        }),
        true,
      );
    });

    it('queue I/O failures resolve to first-in-line, never to a stuck wait', () => {
      const brokenFs = {
        mkdirSync: () => {
          throw new Error('EROFS');
        },
        readdirSync: () => {
          throw new Error('EIO');
        },
      };
      assert.equal(enqueueWaiter({ lockPath, fsImpl: brokenFs }), null);
      assert.equal(
        isFirstInLine({ lockPath, ticket: null, staleMs: 1, fsImpl: brokenFs }),
        true,
      );
      assert.doesNotThrow(() => {
        refreshTicket(null);
        refreshTicket({ file: path.join(dir, 'missing') });
        dequeueWaiter(null);
        dequeueWaiter({ file: path.join(dir, 'missing'), detach: () => {} });
      });
    });
  });

  describe('visibility and expiry (Story #5377)', () => {
    it('AC-9: a waiter reports it is still waiting at least every 30s', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      const stamps = [];
      const clock = fakeClock();
      await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          waitMs: 120_000,
          log: () => stamps.push(clock.nowFn()),
          nowFn: clock.nowFn,
          sleepFn: clock.sleepFn,
        },
        async () => 0,
      );
      holder.release();
      assert.ok(stamps.length >= 5, 'start, ≥3 still-waiting, and expiry');
      for (let i = 1; i < stamps.length; i += 1) {
        assert.ok(
          stamps[i] - stamps[i - 1] <= 30_000,
          `gap ${stamps[i] - stamps[i - 1]}ms between wait lines exceeds 30s`,
        );
      }
    });

    it('onWaitExpired stands in for the spawn only when the wait expired', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      let spawns = 0;
      const lines = [];
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          waitMs: 4_000,
          log: (m) => lines.push(m),
          onWaitExpired: () => LOCK_WAIT_EXPIRED_EXIT_CODE,
          ...fakeClock(),
        },
        async () => {
          spawns += 1;
          return 0;
        },
      );
      holder.release();
      assert.equal(code, LOCK_WAIT_EXPIRED_EXIT_CODE);
      assert.equal(spawns, 0);
      assert.match(lines.at(-1), /not spawning/);
      const uncontended = await withFullSuiteLockAsync(
        { cwd: dir, lockPath, onWaitExpired: () => 75 },
        async () => 0,
      );
      assert.equal(uncontended, 0);
    });

    it('parseLockWaitOutcome reads only a wait’s final line', () => {
      assert.equal(
        parseLockWaitOutcome(
          '[full-suite-lock] ⏳ still waiting (holding pid 1, waited 25s).',
        ),
        null,
      );
      assert.equal(parseLockWaitOutcome(undefined), null);
      assert.deepEqual(
        parseLockWaitOutcome(
          '[coverage-capture] [full-suite-lock] ✅ acquired the full-suite lock (waited 42s).',
        ),
        { waitedSeconds: 42, expired: false },
      );
      assert.deepEqual(
        parseLockWaitOutcome(
          '[full-suite-lock] ⌛ gave up waiting for the full-suite lock (waited 300s, holding pid 9) — spawning anyway.',
        ),
        { waitedSeconds: 300, expired: true },
      );
    });
  });

  // The decorator the CLI applies to `runCapture`. It resolves both escape
  // hatches once, then serializes every spawn the wrapped runner makes.
  describe('lockedCapture', () => {
    it('holds the lock across the wrapped runner and forwards its options', async () => {
      const seen = [];
      const wrapped = lockedCapture(async (opts) => {
        seen.push({ ...opts });
        return 0;
      }, {});
      assert.equal(await wrapped({ cwd: dir, timeoutMs: 99 }), 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].cwd, dir);
      assert.equal(seen[0].timeoutMs, 99);
    });

    it('a disabling config short-circuits the lock entirely', async () => {
      let calls = 0;
      const wrapped = lockedCapture(
        async () => {
          calls += 1;
          return 0;
        },
        { delivery: { execution: { fullSuiteLock: false } } },
      );
      assert.equal(await wrapped({ cwd: dir }), 0);
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(lockPath), false);
    });

    it('AC-8: outside close an expired wait still spawns the suite', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      let spawns = 0;
      const wrapped = lockedCapture(
        async () => {
          spawns += 1;
          return 0;
        },
        {},
        {},
        { lockPath, waitMs: 0 },
      );
      const code = await wrapped({ cwd: dir });
      holder.release();
      assert.equal(code, 0);
      assert.equal(spawns, 1, 'pre-push and a direct run keep spawn-anyway');
    });

    it('AC-7: under close’s opt-in an expired wait spawns nothing and exits 75', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      let spawns = 0;
      const wrapped = lockedCapture(
        async () => {
          spawns += 1;
          return 0;
        },
        {},
        { [FULL_SUITE_LOCK_EXPIRY_ENV]: 'defer' },
        { lockPath, waitMs: 0 },
      );
      const code = await wrapped({ cwd: dir });
      holder.release();
      assert.equal(code, LOCK_WAIT_EXPIRED_EXIT_CODE);
      assert.equal(spawns, 0);
    });

    it('tolerates a runner invoked with no options at all', async () => {
      const wrapped = lockedCapture(async () => 4, {
        delivery: { execution: { fullSuiteLock: false } },
      });
      assert.equal(await wrapped(), 4);
    });
  });

  // The close chain's other end of this contract: the standalone `test` gate
  // is the one gate that spawns a whole suite, and `gates.js` flags it so the
  // runner serializes it. What matters here is that the flag routes through
  // the lock WITHOUT changing the gate's observable result — a lock defect
  // must never turn a green gate red.
  describe('defaultGateRunner honours the fullSuiteLock flag', () => {
    const node = process.execPath;

    it('runs the child and reports its status with the flag set', async () => {
      const result = await defaultGateRunner(node, ['-e', 'process.exit(0)'], {
        cwd: dir,
        gateName: 'test',
        log: () => {},
        fullSuiteLock: true,
      });
      assert.deepEqual(result, { status: 0 });
    });

    it('propagates a non-zero child exit with the flag set', async () => {
      const result = await defaultGateRunner(node, ['-e', 'process.exit(3)'], {
        cwd: dir,
        gateName: 'test',
        log: () => {},
        fullSuiteLock: true,
      });
      assert.deepEqual(result, { status: 3 });
    });

    it('takes the unwrapped path when the flag is absent', async () => {
      const result = await defaultGateRunner(node, ['-e', 'process.exit(0)'], {
        cwd: dir,
        gateName: 'lint',
        log: () => {},
      });
      assert.deepEqual(result, { status: 0 });
      assert.equal(fs.existsSync(lockPath), false);
    });
  });

  describe('the post-wait re-probe (Story #5278)', () => {
    it('a caller that waited and finds it satisfied returns without spawning', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          sleepFn: async () => holder.release(),
          skipIfSatisfied: () => ({ status: 0 }),
        },
        async () => {
          spawns += 1;
          return { status: 1 };
        },
      );
      assert.deepEqual(code, { status: 0 }, 'the probe value stands in');
      assert.equal(spawns, 0, 'the suite must not run a second time');
      assert.equal(fs.existsSync(lockPath), false, 'and the lock is released');
    });

    it('an undefined verdict still spawns — the probe can only skip', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          sleepFn: async () => holder.release(),
          skipIfSatisfied: () => undefined,
        },
        async () => {
          spawns += 1;
          return 3;
        },
      );
      assert.equal(code, 3);
      assert.equal(spawns, 1);
    });

    it('is never consulted on the uncontended path', async () => {
      let probed = 0;
      const code = await withFullSuiteLockAsync(
        {
          cwd: dir,
          lockPath,
          skipIfSatisfied: () => {
            probed += 1;
            return 0;
          },
        },
        async () => 9,
      );
      assert.equal(code, 9, 'no wait happened, so nothing changed underneath');
      assert.equal(probed, 0);
    });
  });
});
