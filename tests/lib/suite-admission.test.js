import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCloseValidation } from '../../.agents/scripts/lib/close-validation/runner.js';
import {
  FULL_SUITE_LOCK_ENV,
  fullSuiteLockPolicy,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
  withFullSuiteLockAsync,
} from '../../.agents/scripts/lib/full-suite-lock.js';
import { acquireSweepLock } from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import {
  ADMISSION_REFUSED_EXIT_CODE,
  createAttempt,
  describeBlocking,
  FULL_SUITE_STALE_MS,
  resolveSuiteCapacity,
} from '../../.agents/scripts/lib/suite-admission.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  hashCommandConfig,
  recordPass,
  shouldSkip,
} from '../../.agents/scripts/lib/validation-evidence.js';

/**
 * Story #5668 — capacity admission. These drive real lockfiles and
 * reservation files in a temp directory; only the clock is faked, so a
 * five-minute wait runs in microseconds.
 */

const LONG = 'npm run test:full';
const FOCUSED = 'python scripts/validation.py --workers 4 --changed-since x';

/** Classification as every caller resolves it. */
function classifySuiteWorkload({ config, argv }) {
  return fullSuiteLockPolicy(config, {}, argv).workload;
}

function workloads(...entries) {
  return { delivery: { execution: { capacity: 10, workloads: entries } } };
}

function fakeClock(onSleep = () => {}) {
  let now = 1_000_000;
  return {
    nowFn: () => now,
    sleepFn: async (ms) => {
      now += ms;
      await onSleep(now);
    },
  };
}

/** A spawn the test finishes by hand, so two runs can be held open at once. */
function heldSpawn() {
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const state = { started: false, finish: (code = 0) => finish(code) };
  state.spawn = async () => {
    state.started = true;
    return done;
  };
  return state;
}

describe('suite admission (Story #5668)', () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = makeTempDir('mandrel-admit-');
    lockPath = path.join(dir, 'full-suite.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The admission policy a caller resolves for `command`, pointed at `dir`. */
  function policy(config, command, extra = {}) {
    const resolved = fullSuiteLockPolicy(config, {}, command.split(' '));
    return { ...resolved, cwd: dir, lockPath, ...extra };
  }

  describe('classification', () => {
    const config = workloads(
      { command: LONG, weight: 6 },
      { command: FOCUSED, weight: 4, resources: ['db'] },
    );

    it('matches the exact argv, whitespace-normalized', () => {
      const workload = classifySuiteWorkload({
        config,
        argv: [
          'python',
          'scripts/validation.py',
          '--workers',
          '4',
          '--changed-since',
          'x',
        ],
      });
      assert.deepEqual(workload, {
        kind: 'declared',
        command: FOCUSED,
        weight: 4,
        resources: ['db'],
      });
      assert.equal(
        classifySuiteWorkload({
          config,
          argv: [' ', ...LONG.split(' ').map((w) => `${w}  `)],
        }).command,
        LONG,
      );
    });

    it('never infers safety from a prefix, a substring or a flag', () => {
      for (const argv of [
        'python scripts/validation.py --workers 4',
        `${FOCUSED} --extra`,
        'python scripts/validation.py --changed-since x',
      ]) {
        assert.deepEqual(
          classifySuiteWorkload({ config, argv: argv.split(' ') }),
          { kind: 'exclusive' },
          argv,
        );
      }
    });

    it('treats every spawn as exclusive when nothing is declared', () => {
      assert.deepEqual(
        classifySuiteWorkload({
          config: { delivery: {} },
          argv: ['npm', 'test'],
        }),
        { kind: 'exclusive' },
      );
    });

    it('refuses a declared weight above capacity', () => {
      const big = workloads({ command: LONG, weight: 11 });
      assert.deepEqual(
        classifySuiteWorkload({ config: big, argv: LONG.split(' ') }),
        { kind: 'refused', command: LONG, weight: 11, capacity: 10 },
      );
    });

    it('defaults capacity to the host parallelism', () => {
      assert.equal(
        resolveSuiteCapacity({}, { availableParallelism: () => 12 }),
        12,
      );
      assert.equal(
        resolveSuiteCapacity({ delivery: { execution: { capacity: 3 } } }),
        3,
      );
    });
  });

  describe('overlap and capacity', () => {
    it('admits a declared focused run beside a running declared suite', async () => {
      const config = workloads(
        { command: LONG, weight: 6 },
        { command: FOCUSED, weight: 4 },
      );
      const long = heldSpawn();
      const longRun = withFullSuiteLockAsync(policy(config, LONG), long.spawn);
      await Promise.resolve();
      assert.equal(long.started, true);
      let focusedRan = false;
      const code = await withFullSuiteLockAsync(
        policy(config, FOCUSED, fakeClock()),
        async () => {
          focusedRan = true;
          return 0;
        },
      );
      assert.equal(code, 0);
      assert.equal(focusedRan, true, 'the focused run started mid-suite');
      long.finish(0);
      assert.equal(await longRun, 0);
      assert.deepEqual(liveReservations(), []);
    });

    it('waits when the live weights leave no room, and runs once capacity frees', async () => {
      const config = workloads(
        { command: LONG, weight: 8 },
        { command: FOCUSED, weight: 4 },
      );
      const long = heldSpawn();
      const longRun = withFullSuiteLockAsync(policy(config, LONG), long.spawn);
      const events = [];
      let ranAt = null;
      const clock = fakeClock((now) => {
        if (now >= 1_060_000) long.finish(0);
      });
      const code = await withFullSuiteLockAsync(
        policy(config, FOCUSED, {
          ...clock,
          onLockProgress: (e) => events.push(e),
        }),
        async () => {
          ranAt = clock.nowFn();
          return 0;
        },
      );
      await longRun;
      assert.equal(code, 0);
      assert.ok(ranAt >= 1_060_000, 'not admitted while 8 + 4 > 10');
      assert.deepEqual(events[0].blocking, {
        reason: 'capacity',
        used: 8,
        requested: 4,
        capacity: 10,
      });
      assert.deepEqual(events.map((e) => e.phase).slice(-2), [
        'admitted',
        'completed',
      ]);
    });

    it('never overlaps two runs that share a resource, even with capacity to spare', async () => {
      const config = workloads(
        { command: LONG, weight: 2, resources: ['coverage'] },
        { command: FOCUSED, weight: 2, resources: ['coverage', 'db'] },
      );
      const long = heldSpawn();
      const longRun = withFullSuiteLockAsync(policy(config, LONG), long.spawn);
      const events = [];
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        policy(config, FOCUSED, {
          ...fakeClock(),
          waitMs: 10_000,
          onLockProgress: (e) => events.push(e),
        }),
        async () => {
          spawns += 1;
          return 0;
        },
      );
      long.finish(0);
      await longRun;
      assert.equal(code, LOCK_WAIT_EXPIRED_EXIT_CODE);
      assert.equal(spawns, 0);
      assert.equal(events[0].blocking.reason, 'resource');
      assert.equal(events[0].blocking.resource, 'coverage');
    });

    it('declared runs with disjoint resources take no repository-wide exclusion', async () => {
      const config = workloads(
        { command: LONG, weight: 2, resources: ['coverage'] },
        { command: FOCUSED, weight: 2, resources: ['db'] },
      );
      const long = heldSpawn();
      const longRun = withFullSuiteLockAsync(policy(config, LONG), long.spawn);
      assert.equal(fs.existsSync(lockPath), false, 'no legacy lock taken');
      const code = await withFullSuiteLockAsync(
        policy(config, FOCUSED, fakeClock()),
        async () => 0,
      );
      long.finish(0);
      await longRun;
      assert.equal(code, 0);
    });
  });

  describe('exclusive runs', () => {
    it('a live legacy holder blocks every declared run', async () => {
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      const events = [];
      const code = await withFullSuiteLockAsync(
        policy(workloads({ command: FOCUSED, weight: 1 }), FOCUSED, {
          ...fakeClock(),
          waitMs: 10_000,
          onLockProgress: (e) => events.push(e),
        }),
        async () => 0,
      );
      holder.release();
      assert.equal(code, LOCK_WAIT_EXPIRED_EXIT_CODE);
      assert.equal(events[0].blocking.reason, 'exclusive');
    });

    it('an undeclared run holds the legacy lock and drains live reservations first', async () => {
      const config = workloads({ command: FOCUSED, weight: 4 });
      const focused = heldSpawn();
      const focusedRun = withFullSuiteLockAsync(
        policy(config, FOCUSED),
        focused.spawn,
      );
      let lockHeldWhileDraining = false;
      let spawnedAt = null;
      const clock = fakeClock((now) => {
        lockHeldWhileDraining ||= fs.existsSync(lockPath);
        if (now >= 1_030_000) focused.finish(0);
      });
      const code = await withFullSuiteLockAsync(
        policy(config, 'npm test', clock),
        async () => {
          spawnedAt = clock.nowFn();
          return 0;
        },
      );
      await focusedRun;
      assert.equal(code, 0);
      assert.ok(spawnedAt >= 1_030_000, 'waited for the reservation');
      assert.equal(
        lockHeldWhileDraining,
        true,
        'nothing new admitted meanwhile',
      );
      assert.equal(fs.existsSync(lockPath), false, 'released after the run');
    });
  });

  describe('fairness and recovery', () => {
    it('a declared run that fits never overtakes an earlier live waiter', async () => {
      const queueDir = `${lockPath}.queue`;
      fs.mkdirSync(queueDir, { recursive: true });
      const ahead = path.join(
        queueDir,
        `000000000000001-000001-${process.pid}-ab`,
      );
      fs.writeFileSync(ahead, '');
      let ranAt = null;
      const clock = fakeClock((now) => {
        if (now >= 1_020_000) fs.rmSync(ahead, { force: true });
        else fs.utimesSync(ahead, new Date(), new Date());
      });
      const code = await withFullSuiteLockAsync(
        policy(workloads({ command: FOCUSED, weight: 1 }), FOCUSED, clock),
        async () => {
          ranAt = clock.nowFn();
          return 0;
        },
      );
      assert.equal(code, 0);
      assert.ok(ranAt >= 1_020_000);
    });

    it("a dead holder's reservation is reclaimed, never counted", async () => {
      const reservations = `${lockPath}.reservations`;
      fs.mkdirSync(reservations, { recursive: true });
      const dead = path.join(reservations, 'w10~~999999999-dead.lock');
      fs.writeFileSync(dead, 'x\n2026-01-01T00:00:00.000Z\n999999999\n');
      let sleeps = 0;
      const code = await withFullSuiteLockAsync(
        policy(workloads({ command: FOCUSED, weight: 4 }), FOCUSED, {
          sleepFn: async () => {
            sleeps += 1;
          },
        }),
        async () => 0,
      );
      assert.equal(code, 0);
      assert.equal(sleeps, 0);
      assert.equal(fs.existsSync(dead), false);
    });

    it('a thrown spawn still releases its reservation', async () => {
      await assert.rejects(
        withFullSuiteLockAsync(
          policy(workloads({ command: FOCUSED, weight: 4 }), FOCUSED),
          async () => {
            throw new Error('suite crashed');
          },
        ),
        /suite crashed/,
      );
      assert.deepEqual(liveReservations(), []);
      assert.deepEqual(fs.readdirSync(`${lockPath}.reservations`), []);
    });
  });

  describe('refusal and the opt-out', () => {
    it('refuses an oversized declaration with exit 78 and never spawns', async () => {
      const lines = [];
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        policy(workloads({ command: FOCUSED, weight: 64 }), FOCUSED, {
          log: (m) => lines.push(m),
        }),
        async () => {
          spawns += 1;
          return 0;
        },
      );
      assert.equal(code, ADMISSION_REFUSED_EXIT_CODE);
      assert.equal(spawns, 0);
      assert.match(
        lines[0],
        /weight 64, above delivery\.execution\.capacity 10/,
      );
    });

    it('fullSuiteLock: false turns admission off entirely', async () => {
      const config = workloads({ command: FOCUSED, weight: 64 });
      config.delivery.execution.fullSuiteLock = false;
      const code = await withFullSuiteLockAsync(
        policy(config, FOCUSED),
        async () => 0,
      );
      assert.equal(code, 0, 'no refusal, no lock');
      assert.equal(fs.existsSync(`${lockPath}.reservations`), false);
    });

    it("close's test gate honours both off switches", async () => {
      const seen = [];
      const runner = async (_cmd, _args, opts) => {
        seen.push(opts.lockOptions);
        return { status: 0 };
      };
      const gates = [
        { name: 'test', cmd: 'node', args: ['-e', '0'], fullSuiteLock: true },
      ];
      await runCloseValidation({
        cwd: dir,
        gates,
        runner,
        config: { delivery: { execution: { fullSuiteLock: false } } },
      });
      const previous = process.env[FULL_SUITE_LOCK_ENV];
      process.env[FULL_SUITE_LOCK_ENV] = '0';
      try {
        await runCloseValidation({ cwd: dir, gates, runner, config: {} });
      } finally {
        if (previous === undefined) delete process.env[FULL_SUITE_LOCK_ENV];
        else process.env[FULL_SUITE_LOCK_ENV] = previous;
      }
      await runCloseValidation({
        cwd: dir,
        gates,
        runner,
        config: workloads({ command: 'node -e 0', weight: 2 }),
      });
      assert.deepEqual(
        seen.map((o) => o.enabled),
        [false, false, true],
      );
      assert.equal(seen[2].workload.kind, 'declared');
    });
  });

  describe('the admission mutex', () => {
    it('a process mid-admission makes the next one wait, never double-admit', async () => {
      const busy = acquireSweepLock({
        lockPath: `${lockPath}.admission`,
        timeoutMs: 600_000,
      });
      const events = [];
      let ranAt = null;
      const clock = fakeClock((now) => {
        if (now >= 1_004_000) busy.release();
      });
      const code = await withFullSuiteLockAsync(
        policy(workloads({ command: FOCUSED, weight: 1 }), FOCUSED, {
          ...clock,
          onLockProgress: (e) => events.push(e),
        }),
        async () => {
          ranAt = clock.nowFn();
          return 0;
        },
      );
      assert.equal(code, 0);
      assert.ok(ranAt >= 1_004_000);
      assert.equal(events[0].blocking.reason, 'admission');
    });

    it('an unwritable lock home fails open: the run proceeds unserialized', async () => {
      const notADir = path.join(dir, 'file');
      fs.writeFileSync(notADir, '');
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        {
          ...policy(workloads({ command: FOCUSED, weight: 1 }), FOCUSED),
          lockPath: path.join(notADir, 'full-suite.lock'),
        },
        async () => {
          spawns += 1;
          return 0;
        },
      );
      assert.equal(code, 0);
      assert.equal(spawns, 1);
    });

    it('names every blocking reason in plain words', () => {
      const cases = [
        [
          { reason: 'capacity', used: 6, requested: 4, capacity: 8 },
          /capacity 6\/8 in use, 4 requested/,
        ],
        [{ reason: 'resource', resource: 'db' }, /resource "db" is held/],
        [{ reason: 'exclusive' }, /exclusive full suite/],
        [{ reason: 'queue' }, /earlier waiter/],
        [{ reason: 'admission' }, /mid-admission/],
        [{ reason: 'other' }, /^blocked$/],
        [undefined, /^blocked$/],
      ];
      for (const [blocking, expected] of cases) {
        assert.match(describeBlocking(blocking), expected);
      }
    });
  });

  describe('evidence isolation', () => {
    it("a concurrent pass for another Story or worktree never satisfies a waiter's re-probe", async () => {
      const config = workloads(
        { command: LONG, weight: 8 },
        { command: FOCUSED, weight: 4 },
      );
      const [cmd, ...args] = FOCUSED.split(' ');
      const store = { cwd: dir, standalone: true };
      const elsewhere = hashCommandConfig({
        cmd,
        args,
        cwd: path.join(dir, 'b'),
      });
      recordPass(
        { storyId: 2, gateName: 'test', sha: 'abc1234', configHash: elsewhere },
        store,
      );
      const mine = hashCommandConfig({ cmd, args, cwd: path.join(dir, 'a') });
      const satisfied = (storyId, configHash) => () =>
        shouldSkip(
          { storyId, gateName: 'test', currentSha: 'abc1234', configHash },
          store,
        ).skip
          ? 0
          : undefined;
      const long = heldSpawn();
      const longRun = withFullSuiteLockAsync(policy(config, LONG), long.spawn);
      let spawns = 0;
      const code = await withFullSuiteLockAsync(
        policy(config, FOCUSED, {
          ...fakeClock((now) => {
            if (now >= 1_010_000) long.finish(0);
          }),
          // Story 1 waited; Story 2's pass in another worktree is not its own.
          skipIfSatisfied: satisfied(1, mine),
        }),
        async () => {
          spawns += 1;
          return 0;
        },
      );
      await longRun;
      assert.equal(code, 0);
      assert.equal(spawns, 1, 'ran its own suite');
      assert.equal(satisfied(1, elsewhere)(), undefined, "not Story 1's");
      assert.equal(satisfied(2, mine)(), undefined, "not this worktree's");
      assert.equal(satisfied(2, elsewhere)(), 0, 'only the owner matches');
    });
  });

  function liveReservations() {
    const dir = `${lockPath}.reservations`;
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }
});

/**
 * Story #5684 — the exclusive drain check used to skip the admission mutex
 * whenever the reservations directory read empty. A declared run that had
 * passed its legacy-holder check but not yet written its reservation is
 * exactly that state, so both could be admitted. The interleaving is made
 * deterministic by pausing the declared run inside its legacy-holder stat and
 * running the exclusive attempt to completion there.
 */
describe('suite admission — exclusive vs mid-admission declared (Story #5684)', () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = makeTempDir('mandrel-admit-race-');
    lockPath = path.join(dir, 'full-suite.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A lock acquirer with no heartbeat or signal hooks, so tests leak none. */
  const quietAcquire = (o) =>
    acquireSweepLock({ ...o, heartbeatMs: 0, processImpl: null });

  function attemptOpts(extra) {
    return {
      lockPath,
      capacity: 10,
      staleMs: FULL_SUITE_STALE_MS,
      fsImpl: fs,
      nowFn: Date.now,
      acquireOnceFn: quietAcquire,
      acquireReservationFn: quietAcquire,
      ...extra,
    };
  }

  /** `fs`, except the first stat of `target` runs `onPause` after it returns. */
  function pauseAfterFirstStat(target, onPause) {
    let paused = false;
    return {
      ...fs,
      statSync(p, ...rest) {
        let result;
        let error;
        try {
          result = fs.statSync(p, ...rest);
        } catch (err) {
          error = err;
        }
        if (p === target && !paused) {
          paused = true;
          onPause();
        }
        if (error) throw error;
        return result;
      },
    };
  }

  it('AC-1: an exclusive attempt is blocked while a declared run is mid-admission', () => {
    const exclusive = createAttempt(
      attemptOpts({ workload: { kind: 'exclusive' } }),
    );
    let midAdmission = null;
    const declared = createAttempt(
      attemptOpts({
        workload: {
          kind: 'declared',
          command: FOCUSED,
          weight: 4,
          resources: [],
        },
        // Paused after the legacy-holder check found no holder, before the
        // reservation is written: the exclusive run takes its turn here.
        fsImpl: pauseAfterFirstStat(lockPath, () => {
          midAdmission = exclusive.tryOnce();
        }),
      }),
    );

    try {
      const admitted = declared.tryOnce();
      assert.equal(admitted.acquired, true, 'the declared run is admitted');
      assert.equal(
        midAdmission?.acquired,
        false,
        'the exclusive run must not be admitted alongside it',
      );
      assert.equal(midAdmission.blocking.reason, 'admission');

      const nextPoll = exclusive.tryOnce();
      assert.equal(nextPoll.acquired, false, 'still draining the reservation');
      assert.equal(nextPoll.blocking.reason, 'capacity');
      assert.equal(nextPoll.blocking.used, 4);

      declared.release();
      assert.equal(
        exclusive.tryOnce().acquired,
        true,
        'drained, then admitted',
      );
    } finally {
      declared.release();
      exclusive.release();
    }
  });

  it('an admission-mutex I/O error still fails open for the exclusive run', () => {
    const brokenMutexFs = {
      ...fs,
      openSync(p, flags) {
        if (String(p).endsWith('.admission')) {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return fs.openSync(p, flags);
      },
    };
    const exclusive = createAttempt(
      attemptOpts({ workload: { kind: 'exclusive' }, fsImpl: brokenMutexFs }),
    );
    try {
      assert.equal(exclusive.tryOnce().acquired, true);
    } finally {
      exclusive.release();
    }
  });
});
