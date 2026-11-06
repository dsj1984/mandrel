import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCloseValidation } from '../../.agents/scripts/lib/close-validation/runner.js';
import {
  FULL_SUITE_LOCK_ENV,
  fullSuiteLockPolicy,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
  lockedCapture,
  SUITE_RESERVATION_ENV,
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

/**
 * Story #5963 — a tiered workload books its slice's tier weight, and a
 * `backfill` workload may pass earlier declared waiters it provably fits
 * beside while the oldest has waited under the window.
 */
describe('size-aware admission and backfill (Story #5963)', () => {
  const TIERED = 'pnpm run test:coverage:affected';
  const tiered = (extra = {}) => ({
    command: TIERED,
    weight: 8,
    tiers: [
      { maxFiles: 20, weight: 2 },
      { maxFiles: 80, weight: 4 },
    ],
    sizeCommand: 'node scripts/count-slice.js',
    ...extra,
  });
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = makeTempDir('mandrel-admit-size-');
    lockPath = path.join(dir, 'full-suite.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function policy(config, command, extra = {}) {
    const resolved = fullSuiteLockPolicy(config, {}, command.split(' '));
    return { ...resolved, cwd: dir, lockPath, ...extra };
  }

  function sizer(result) {
    const calls = [];
    const runSizeFn = async (o) => {
      calls.push(o);
      return result;
    };
    return { calls, runSizeFn };
  }

  /** The reservation names and child env seen from inside the spawn. */
  async function admitOnce(config, command, extra) {
    let seen = null;
    const code = await withFullSuiteLockAsync(
      policy(config, command, extra),
      async ({ env }) => {
        seen = { env, names: fs.readdirSync(`${lockPath}.reservations`) };
        return 0;
      },
    );
    return { code, ...seen };
  }

  describe('sizing', () => {
    it('AC-1/AC-4: books the covering tier weight and names it in the child env', async () => {
      const { calls, runSizeFn } = sizer({ count: 33 });
      const lines = [];
      const run = await admitOnce(workloads(tiered()), TIERED, {
        runSizeFn,
        env: { BASE: 'x' },
        spawnEnv: { MANDREL_COVERAGE_BASE_REF: 'origin/main' },
        log: (m) => lines.push(m),
      });
      assert.equal(run.code, 0);
      assert.match(run.names[0], /^w4~/);
      assert.equal(run.env.MANDREL_SUITE_WEIGHT, '4');
      assert.ok(run.env[SUITE_RESERVATION_ENV]);
      assert.deepEqual(calls[0].env, {
        BASE: 'x',
        MANDREL_COVERAGE_BASE_REF: 'origin/main',
      });
      assert.equal(calls[0].cwd, dir);
      assert.match(lines[0], /33 files → weight 4 of 8/);
    });

    it('AC-1: a failed sizing books the full declared weight', async () => {
      const { runSizeFn } = sizer({ reason: 'exited 1' });
      const run = await admitOnce(workloads(tiered()), TIERED, { runSizeFn });
      assert.match(run.names[0], /^w8~/);
      assert.equal(run.env.MANDREL_SUITE_WEIGHT, '8');
    });

    it('AC-2: never sizes a refused, lock-disabled or inherited spawn', async () => {
      const { calls, runSizeFn } = sizer({ count: 1 });
      const refused = await withFullSuiteLockAsync(
        policy(workloads(tiered({ weight: 64 })), TIERED, { runSizeFn }),
        async () => 0,
      );
      assert.equal(refused, ADMISSION_REFUSED_EXIT_CODE);
      const off = workloads(tiered());
      off.delivery.execution.fullSuiteLock = false;
      assert.equal(
        await withFullSuiteLockAsync(
          policy(off, TIERED, { runSizeFn }),
          async () => 0,
        ),
        0,
      );
      const parent = heldSpawn();
      let marker = null;
      const parentRun = withFullSuiteLockAsync(
        policy(workloads({ command: FOCUSED, weight: 3 }), FOCUSED),
        async (lock) => {
          marker = lock.env[SUITE_RESERVATION_ENV];
          return parent.spawn();
        },
      );
      await Promise.resolve();
      let childEnv = null;
      await withFullSuiteLockAsync(
        policy(workloads(tiered()), TIERED, {
          runSizeFn,
          env: { [SUITE_RESERVATION_ENV]: marker },
        }),
        async ({ env }) => {
          childEnv = env;
          return 0;
        },
      );
      parent.finish(0);
      await parentRun;
      assert.deepEqual(calls, [], 'sizing never ran');
      assert.equal(childEnv[SUITE_RESERVATION_ENV], marker);
      assert.equal(childEnv.MANDREL_SUITE_WEIGHT, '3', "the parent's weight");
    });

    it('AC-9: a capture runs the same argv whether sized to a tier or to full weight', async () => {
      const config = {
        delivery: {
          quality: { gates: { coverage: { captureScript: 'cov' } } },
          execution: {
            capacity: 10,
            workloads: [tiered({ command: 'npm run cov' })],
          },
        },
      };
      const runs = [];
      const log = () => {};
      for (const result of [{ count: 2 }, { reason: 'exited 1' }]) {
        const { calls, runSizeFn } = sizer(result);
        const wrapped = lockedCapture(
          async ({ env, ...rest }) => {
            runs.push({ rest, weight: env.MANDREL_SUITE_WEIGHT, calls });
            return 0;
          },
          config,
          {},
          { lockPath, runSizeFn },
        );
        await wrapped({
          cwd: dir,
          log,
          env: { MANDREL_COVERAGE_BASE_REF: 'abc' },
        });
      }
      assert.deepEqual(runs[0].rest, runs[1].rest);
      assert.deepEqual(
        [runs[0].weight, runs[1].weight],
        ['2', '8'],
        'only the booked weight differs',
      );
      assert.equal(runs[0].calls[0].env.MANDREL_COVERAGE_BASE_REF, 'abc');
      const [cmd, ...args] = 'npm run cov'.split(' ');
      assert.equal(
        hashCommandConfig({ cmd, args, cwd: dir }),
        hashCommandConfig({ cmd, args, cwd: dir }),
      );
    });
  });

  describe('backfill', () => {
    const SMALL = 'npm run test:small';
    const config = (backfill = true, resources = []) =>
      workloads({ command: SMALL, weight: 2, resources, backfill });

    function ticketAhead(arrival, body) {
      const queueDir = `${lockPath}.queue`;
      fs.mkdirSync(queueDir, { recursive: true });
      const name = `${String(arrival).padStart(15, '0')}-000001-${process.pid}-ab`;
      const file = path.join(queueDir, name);
      fs.writeFileSync(file, body);
      return file;
    }

    const declared = (weight, resources = []) =>
      JSON.stringify({ kind: 'declared', weight, resources });

    /** Run SMALL behind `ticket`, which leaves the queue at 1_020_000. */
    async function runBehind(ticket, cfg, extra = {}) {
      let ranAt = null;
      const outcomes = [];
      const lines = [];
      const clock = fakeClock((now) => {
        if (now >= 1_020_000) fs.rmSync(ticket, { force: true });
        else if (fs.existsSync(ticket))
          fs.utimesSync(ticket, new Date(), new Date());
      });
      const code = await withFullSuiteLockAsync(
        policy(cfg, SMALL, {
          ...clock,
          onLockOutcome: (o) => outcomes.push(o),
          log: (m) => lines.push(m),
          ...extra,
        }),
        async () => {
          ranAt = clock.nowFn();
          return 0;
        },
      );
      assert.equal(code, 0);
      return { ranAt, outcome: outcomes[0], lines };
    }

    it('AC-5: passes an earlier declared waiter it fits beside', async () => {
      const ticket = ticketAhead(1_000_000, declared(6));
      const { ranAt, outcome, lines } = await runBehind(ticket, config());
      assert.ok(ranAt < 1_020_000, 'started while the earlier waiter queued');
      assert.deepEqual(outcome.admission, {
        weight: 2,
        declaredWeight: 2,
        sliceFiles: null,
        backfilled: true,
      });
      assert.ok(
        lines.some((l) =>
          /weight 2 of declared 2, unsized, .*backfilled past 1 earlier/.test(
            l,
          ),
        ),
      );
    });

    it('AC-6: never passes an exclusive, empty or unreadable ticket', async () => {
      for (const body of [JSON.stringify({ kind: 'exclusive' }), '', '{nope']) {
        const ticket = ticketAhead(1_000_000, body);
        const { ranAt } = await runBehind(ticket, config());
        assert.ok(ranAt >= 1_020_000, `waited behind ${JSON.stringify(body)}`);
      }
    });

    it('never passes a waiter it does not fit beside or shares a resource with', async () => {
      const tooBig = ticketAhead(1_000_000, declared(9));
      assert.ok((await runBehind(tooBig, config())).ranAt >= 1_020_000);
      const sharing = ticketAhead(1_000_000, declared(1, ['db']));
      assert.ok(
        (await runBehind(sharing, config(true, ['db']))).ranAt >= 1_020_000,
      );
    });

    it('AC-6: passes no waiter that has waited the backfill window', async () => {
      const ticket = ticketAhead(1_000_000 - 300_000, declared(1));
      assert.ok((await runBehind(ticket, config())).ranAt >= 1_020_000);
      const shortWindow = ticketAhead(1_000_000, declared(1));
      const { ranAt } = await runBehind(shortWindow, config(), {
        backfillWindowMs: 1_000,
      });
      assert.ok(ranAt >= 1_020_000, 'the window is a lock option');
    });

    it('AC-7: an unmarked workload never passes even a fitting declared waiter', async () => {
      const ticket = ticketAhead(1_000_000, declared(1));
      const { ranAt, outcome } = await runBehind(ticket, config(false));
      assert.ok(ranAt >= 1_020_000);
      assert.equal(outcome.admission.backfilled, false);
    });
  });
});
