/**
 * Story #5112 — the sweep lock's liveness and steal contract.
 *
 * The class of defect under test is an interleaving, not a value: a live
 * holder whose critical section outruns `timeoutMs` used to be indistinguish-
 * able from a crashed one, and a stale-breaker unlinked by path rather than by
 * identity, so two breakers could each unlink the other's fresh lockfile and
 * both proceed. Both are reproduced here with fakes — a fake clock, a fake
 * timer, and a fake `fs` whose inode counter models a real unlink/create —
 * because a test that waited out a real 60 s window would be untenable and a
 * test that raced real processes would be flaky.
 *
 * Everything is asserted through the public surface: `acquireSweepLock`, the
 * `release()` it hands back, and the `setIntervalFn` seam it already accepts.
 * "Who holds the lock" is observed the way a competing process observes it —
 * by whether the next acquire is contended, and by whose `release()` actually
 * frees it — never by reaching into the module for an owner-line reader.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  acquireSweepLock,
  readLockHolderPid,
  resolveSweepLockPath,
} from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * An in-memory `fs` shim covering exactly the surface `sweep-lock.js` uses.
 * `ino` increments on every create, so an unlink + create is observably a
 * *different* file — which is the whole point of the identity-checked steal.
 *
 * @param {() => number} nowFn drives mtimes, so the fake clock is the only
 *   clock in the test.
 */
function makeFakeFs(nowFn) {
  const files = new Map();
  let nextIno = 1;
  return {
    files,
    mkdirSync() {},
    openSync(p) {
      if (files.has(p)) {
        const err = new Error(`EEXIST: ${p}`);
        err.code = 'EEXIST';
        throw err;
      }
      files.set(p, { body: '', mtimeMs: nowFn(), ino: nextIno++, dev: 7 });
      return p;
    },
    writeSync(fd, data) {
      files.get(fd).body += data;
    },
    closeSync() {},
    statSync(p) {
      const f = files.get(p);
      if (!f) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs: f.mtimeMs, ino: f.ino, dev: f.dev };
    },
    readFileSync(p) {
      const f = files.get(p);
      if (!f) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return f.body;
    },
    utimesSync(p, _atime, mtime) {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT: ${p}`);
      f.mtimeMs = mtime.getTime();
    },
    unlinkSync(p) {
      if (!files.delete(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
    },
  };
}

/** A fake interval seam: the test fires the callback, not the event loop. */
function makeFakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers,
    setIntervalFn(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearIntervalFn(id) {
      timers.delete(id);
    },
    /** Run every live interval callback once. */
    tick() {
      for (const timer of [...timers.values()]) timer.fn();
    },
    /** The interval the one live heartbeat was scheduled at. */
    intervalMs() {
      return [...timers.values()][0]?.ms ?? null;
    },
  };
}

const LOCK = '/fake/temp/merged-branch-sweep.lock';

/**
 * Is the lock currently held? Asked the way a competing process asks it — by
 * attempting to acquire. Uses a nowFn that never advances so the probe cannot
 * itself trip the staleness rule, and releases anything it happens to win so
 * the probe leaves no trace.
 */
function isHeld(fsImpl, nowMs) {
  const probe = acquireSweepLock({
    lockPath: LOCK,
    ownerId: 'probe',
    nowFn: () => nowMs,
    fsImpl,
    heartbeatMs: 0,
  });
  if (probe.acquired) {
    probe.release();
    return false;
  }
  return true;
}

describe('sweep-lock — heartbeat keeps a live holder alive (Story #5112)', () => {
  it('a second acquire is contended even past the 60s default timeoutMs', () => {
    let now = 1_000_000;
    const fsImpl = makeFakeFs(() => now);
    const timers = makeFakeTimers();

    const holder = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder-a',
      nowFn: () => now,
      fsImpl,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    assert.equal(holder.acquired, true);
    assert.equal(timers.timers.size, 1, 'the holder started a heartbeat');

    // The sweep runs long: advance well past the default 60s window, letting
    // the holder's heartbeat fire as it would in a live process.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 20_000) {
      now += 20_000;
      timers.tick();
    }

    const second = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder-b',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'contended');

    // Still holder-a's lock: only its release frees it.
    holder.release();
    assert.equal(isHeld(fsImpl, now), false, 'the live holder released it');
  });

  it('without a heartbeat the same elapsed time reads stale (the pre-fix behaviour)', () => {
    let now = 1_000_000;
    const fsImpl = makeFakeFs(() => now);
    const dead = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder-a',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });
    assert.equal(dead.acquired, true);

    now += 120_000;
    const second = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder-b',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });
    assert.equal(second.acquired, true, 'stale steal still works when dead');

    // The zombie's late release must not drop the new holder's lock.
    dead.release();
    assert.equal(isHeld(fsImpl, now), true, 'holder-b still holds it');
    second.release();
    assert.equal(isHeld(fsImpl, now), false);
  });

  it('stops heartbeating (and does not resurrect) a lock stolen from it', () => {
    const now = 1_000_000;
    const fsImpl = makeFakeFs(() => now);
    const timers = makeFakeTimers();
    const holder = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder-a',
      nowFn: () => now,
      fsImpl,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    assert.equal(holder.acquired, true);

    // Simulate a steal: another process now owns the file at this path.
    fsImpl.unlinkSync(LOCK);
    fsImpl.openSync(LOCK);
    fsImpl.writeSync(LOCK, 'holder-c\n');

    timers.tick();
    assert.equal(timers.timers.size, 0, 'heartbeat stopped on owner mismatch');
    // And release must not drop the new owner's lock.
    holder.release();
    assert.equal(isHeld(fsImpl, now), true, 'holder-c still holds it');
  });

  it('schedules the heartbeat strictly under the staleness window', () => {
    // Read the interval off the injected timer seam rather than the private
    // derivation, so the assertion is about what the lock actually schedules.
    const intervalFor = (timeoutMs) => {
      const now = 1_000_000;
      const timers = makeFakeTimers();
      const held = acquireSweepLock({
        lockPath: LOCK,
        timeoutMs,
        ownerId: 'holder',
        nowFn: () => now,
        fsImpl: makeFakeFs(() => now),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      });
      assert.equal(held.acquired, true);
      return timers.intervalMs();
    };

    assert.ok(intervalFor(60_000) < 60_000);
    assert.equal(intervalFor(60_000), 20_000);
    // Floor: never sub-second, however small the configured timeout.
    assert.equal(intervalFor(30), 1_000);
  });
});

describe('sweep-lock — two stale-breakers yield exactly one acquisition', () => {
  it('the loser does not unlink the winner’s fresh lockfile', () => {
    let now = 1_000_000;
    const fsImpl = makeFakeFs(() => now);

    // A crashed holder leaves a lockfile behind.
    fsImpl.openSync(LOCK);
    fsImpl.writeSync(LOCK, 'crashed-owner\n');
    const crashedIno = fsImpl.statSync(LOCK).ino;
    now += 120_000;

    const breakerA = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'breaker-a',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });
    const breakerB = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'breaker-b',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });

    const acquisitions = [breakerA, breakerB].filter((r) => r.acquired);
    assert.equal(acquisitions.length, 1, 'exactly one breaker acquired');
    assert.equal(breakerA.acquired, true);
    assert.equal(breakerB.acquired, false);
    assert.equal(breakerB.reason, 'contended');

    // The winner's lockfile is a genuinely new file: the loser observed the
    // *crashed* file's identity, re-statted, saw a different inode, and
    // refused to unlink.
    assert.notEqual(fsImpl.statSync(LOCK).ino, crashedIno);
    // The loser is handed no release at all — it owns nothing to give back —
    // and the lock stays held until the winner releases it.
    assert.equal(breakerB.release, undefined);
    assert.equal(
      isHeld(fsImpl, now),
      true,
      'still held after the loser gave up',
    );
    breakerA.release();
    assert.equal(isHeld(fsImpl, now), false, 'the winner freed it');
  });

  it('refuses the steal when the observed file was replaced under it', () => {
    let now = 1_000_000;
    const fsImpl = makeFakeFs(() => now);
    fsImpl.openSync(LOCK);
    fsImpl.writeSync(LOCK, 'crashed-owner\n');
    const originalIno = fsImpl.statSync(LOCK).ino;
    now += 120_000;

    // Replace the file between the staleness stat and the identity re-stat by
    // making the second stat report a different inode.
    const realStat = fsImpl.statSync.bind(fsImpl);
    let stats = 0;
    fsImpl.statSync = (p) => {
      const st = realStat(p);
      stats += 1;
      return stats === 1 ? st : { ...st, ino: st.ino + 100 };
    };

    const result = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'breaker-a',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'contended');
    // The observed-but-changed file was left alone, not unlinked.
    assert.equal(realStat(LOCK).ino, originalIno);
  });
});

describe('sweep-lock — release is owner-checked', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir('sweep-lock-steal-');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('a late release leaves the current holder’s lock in place (real fs)', () => {
    const lockPath = path.join(tmpDir, 'sweep.lock');
    const first = acquireSweepLock({ lockPath, ownerId: 'first' });
    assert.equal(first.acquired, true);

    // First "crashes" without releasing; a later run steals the stale lock.
    const oldTime = Date.now() / 1000 - 600;
    fs.utimesSync(lockPath, oldTime, oldTime);
    const second = acquireSweepLock({ lockPath, ownerId: 'second' });
    assert.equal(second.acquired, true);

    // The zombie's release must be a no-op — the file is not its lock.
    first.release();
    assert.equal(fs.existsSync(lockPath), true);
    const contended = acquireSweepLock({ lockPath, ownerId: 'third' });
    assert.equal(contended.acquired, false, 'second still holds the lock');

    second.release();
    assert.equal(fs.existsSync(lockPath), false);
  });
});

describe('sweep-lock — one lock for the merged-branch reap (Story #5112)', () => {
  it('resolveSweepLockPath is deterministic under the tempRoot', () => {
    const a = resolveSweepLockPath({ cwd: '/repo', tempRoot: 'temp' });
    const b = resolveSweepLockPath({ cwd: '/repo', tempRoot: 'temp' });
    assert.equal(a, b);
    assert.equal(a, path.resolve('/repo', 'temp', 'merged-branch-sweep.lock'));
  });

  it('defaults the tempRoot to temp/', () => {
    assert.equal(
      resolveSweepLockPath({ cwd: '/repo' }),
      path.resolve('/repo', 'temp', 'merged-branch-sweep.lock'),
    );
  });
});

// ---------------------------------------------------------------------------
// Story #5173 — `readLockHolderPid`, the projection a *waiting* caller uses to
// name the holder. It is advisory by construction: every unreadable shape
// resolves to `null` so a wait line can degrade to "unknown" rather than throw
// on the way to a lock the caller was going to proceed without anyway.
// ---------------------------------------------------------------------------
describe('readLockHolderPid (Story #5173)', () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = makeTempDir('sweep-lock-pid-');
    lockPath = path.join(dir, 'x.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads back the pid a real acquire stamped', () => {
    const lock = acquireSweepLock({ lockPath, timeoutMs: 60_000 });
    assert.equal(lock.acquired, true);
    assert.equal(readLockHolderPid(lockPath), process.pid);
    lock.release();
  });

  it('returns null for an absent lockfile', () => {
    assert.equal(readLockHolderPid(lockPath), null);
  });

  it('returns null when the pid line is missing or unparseable', () => {
    for (const body of ['owner\n', 'owner\nstamp\n', 'owner\nstamp\nnope\n']) {
      fs.writeFileSync(lockPath, body);
      assert.equal(
        readLockHolderPid(lockPath),
        null,
        `expected null for ${JSON.stringify(body)}`,
      );
    }
  });

  it('returns null for a non-positive pid', () => {
    fs.writeFileSync(lockPath, 'owner\nstamp\n0\n');
    assert.equal(readLockHolderPid(lockPath), null);
  });
});

/**
 * Story #5278 — the two liveness signals the mtime heuristic could not give.
 *
 * `timeoutMs` answers "how long since the holder last got a turn on the event
 * loop", which is only a proxy for "is the holder still working". These pin
 * the two places the proxy was wrong in a way that cost real time: a holder
 * that is *definitely gone* (its pid no longer exists) had to be waited out
 * anyway, and a holder killed by Ctrl-C left its lockfile behind for every
 * sibling to wait out in turn.
 */
describe('sweep-lock — a dead holder is reclaimed at once (Story #5278)', () => {
  /** Plant a held lockfile whose pid line names `pid`, at `mtimeMs`. */
  function plantHolder(fsImpl, { pid, nowFn }) {
    const holder = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder',
      nowFn,
      fsImpl,
      heartbeatMs: 0,
    });
    assert.equal(holder.acquired, true);
    // `tryCreateLock` stamps the real `process.pid`; rewrite the third line so
    // the test controls which process the lockfile claims to belong to.
    const file = fsImpl.files.get(LOCK);
    const [owner, ts] = String(file.body).split('\n');
    file.body = `${owner}\n${ts}\n${pid}\n`;
    return holder;
  }

  // AC-3 — no waiting for `staleMs` on a lock nobody is behind.
  it('AC-3: an ESRCH pid is stale immediately, well inside timeoutMs', () => {
    let now = 1_000;
    const fsImpl = makeFakeFs(() => now);
    plantHolder(fsImpl, { pid: 424_242, nowFn: () => now });

    now += 1_000; // a thousandth of the 60s window: nowhere near stale
    const taken = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'next',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
      killFn: () => {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      },
    });
    assert.equal(taken.acquired, true, 'a dead holder must not be waited out');
  });

  it('AC-3: is one-directional — a live pid still goes stale on mtime', () => {
    let now = 1_000;
    const fsImpl = makeFakeFs(() => now);
    plantHolder(fsImpl, { pid: 4711, nowFn: () => now });

    // Alive and fresh: contended, exactly as before.
    assert.equal(
      isHeldWithKill(fsImpl, now + 1_000, () => {}),
      true,
    );
    // Alive but long past the window: the mtime rule still reclaims it. A
    // live pid must never make a hung holder immortal — that would break the
    // reclaim contract `withFullSuiteLockSync` depends on.
    now += 10 * 60_000;
    const taken = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'next',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
      killFn: () => {},
    });
    assert.equal(taken.acquired, true);
  });

  it('AC-3: an unreadable pid falls back to the mtime heuristic unchanged', () => {
    let now = 1_000;
    const fsImpl = makeFakeFs(() => now);
    const holder = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
    });
    assert.equal(holder.acquired, true);
    fsImpl.files.get(LOCK).body = 'holder\nts\n'; // no pid line at all

    now += 1_000;
    assert.equal(
      isHeldWithKill(fsImpl, now, () => {}),
      true,
      'fresh → held',
    );
    now += 10 * 60_000;
    assert.equal(
      isHeldWithKill(fsImpl, now, () => {}),
      false,
      'old → stale',
    );
  });

  /** {@link isHeld}, with the liveness probe under the test's control. */
  function isHeldWithKill(fsImpl, nowMs, killFn) {
    const probe = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'probe',
      nowFn: () => nowMs,
      fsImpl,
      heartbeatMs: 0,
      killFn,
    });
    if (probe.acquired) {
      probe.release();
      return false;
    }
    return true;
  }
});

describe('sweep-lock — a signalled holder releases before it dies (#5278)', () => {
  /**
   * A fake `process` standing in for the real one: it records the handlers
   * registered against it and lets the test deliver a signal, so the contract
   * ("the lockfile is gone before the re-raise, and the re-raise carries the
   * same signal") is observable without killing the test runner.
   */
  function makeFakeProcess() {
    const listeners = new Map();
    return {
      pid: 4242,
      raised: [],
      once(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      off(event, fn) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((f) => f !== fn),
        );
      },
      kill(_pid, signal) {
        this.raised.push(signal);
      },
      count(event) {
        return (listeners.get(event) ?? []).length;
      },
      deliver(event) {
        for (const fn of [...(listeners.get(event) ?? [])]) fn();
      },
    };
  }

  // AC-4 — the lockfile must be gone by the time the process exits 130.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`AC-4: ${signal} releases the lock, then re-raises the same signal`, () => {
      const now = 1_000;
      const fsImpl = makeFakeFs(() => now);
      const processImpl = makeFakeProcess();
      const holder = acquireSweepLock({
        lockPath: LOCK,
        ownerId: 'holder',
        nowFn: () => now,
        fsImpl,
        heartbeatMs: 0,
        processImpl,
      });
      assert.equal(holder.acquired, true);
      assert.equal(fsImpl.files.has(LOCK), true);

      processImpl.deliver(signal);
      assert.equal(
        fsImpl.files.has(LOCK),
        false,
        'the lockfile must be gone before the process dies',
      );
      assert.deepEqual(
        processImpl.raised,
        [signal],
        're-raising the same signal is what preserves exit 128+signum (130 for SIGINT)',
      );
    });
  }

  it('AC-4: the re-raise cannot loop — the handler detaches itself first', () => {
    const now = 1_000;
    const fsImpl = makeFakeFs(() => now);
    const processImpl = makeFakeProcess();
    acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
      processImpl,
    });
    processImpl.deliver('SIGINT');
    assert.equal(processImpl.count('SIGINT'), 0);
    assert.equal(processImpl.count('SIGTERM'), 0);
  });

  it('a released holder stops intercepting signals it has nothing to clean up for', () => {
    const now = 1_000;
    const fsImpl = makeFakeFs(() => now);
    const processImpl = makeFakeProcess();
    const holder = acquireSweepLock({
      lockPath: LOCK,
      ownerId: 'holder',
      nowFn: () => now,
      fsImpl,
      heartbeatMs: 0,
      processImpl,
    });
    assert.equal(processImpl.count('SIGINT'), 1);
    holder.release();
    assert.equal(processImpl.count('SIGINT'), 0);
    assert.equal(processImpl.count('SIGTERM'), 0);
    processImpl.deliver('SIGINT');
    assert.deepEqual(processImpl.raised, [], 'nothing left to re-raise');
  });
});
