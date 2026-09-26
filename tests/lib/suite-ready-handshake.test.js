/**
 * Story #5485 — the suite timeout is spent on tests, never on waits.
 *
 * Real child processes stand in for the suite (a `spawnImpl` that runs a
 * node one-liner in place of `npm run test:coverage`), so the supervisor's
 * timer, the ready-file poll and the process-group kill are the production
 * code paths. Figures are kept small (hundreds of ms) with generous margins.
 *
 * - AC-3: a lock wait longer than `timeoutMs` does not consume the budget.
 * - AC-4: a pre-ready host wait longer than `timeoutMs` does not either, and
 *   `hostWaitMs` is reported; a child that never signals is killed with 124.
 * - AC-5: `evidence-gate.js --gate test` defers with 75, naming the holder.
 * - AC-8: the timing line carries three separate figures and round-trips.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  runEvidenceGate,
  runLockedSuite,
} from '../../.agents/scripts/evidence-gate.js';
import { runCapture } from '../../.agents/scripts/lib/coverage-capture.js';
import {
  LOCK_WAIT_EXPIRED_EXIT_CODE,
  lockedCapture,
} from '../../.agents/scripts/lib/full-suite-lock.js';
import { readLockHolder } from '../../.agents/scripts/lib/full-suite-queue.js';
import { lockWaitPending } from '../../.agents/scripts/lib/orchestration/single-story-close/phases/lock-wait-pending.js';
import { TIMEOUT_EXIT_CODE } from '../../.agents/scripts/lib/process-group.js';
import { acquireSweepLock } from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import {
  formatSuiteTimings,
  parseSuiteTimings,
  SUITE_READY_FILE_ENV,
  suiteReadyHandshake,
  superviseSuite,
} from '../../.agents/scripts/lib/supervised-suite.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const TIMEOUT_MS = 1_000;
const POLL_MS = 20;

/**
 * A stub suite: optionally waits `hostWaitMs` before writing the ready file
 * (`signal: false` never writes it), then runs for `runMs` and exits 0.
 */
function stubSuite({ hostWaitMs = 0, runMs, signal = true }) {
  const script = `
    const fs = require('node:fs');
    const ready = process.env.${SUITE_READY_FILE_ENV};
    setTimeout(() => {
      if (${signal} && ready) fs.writeFileSync(ready, '');
      setTimeout(() => process.exit(0), ${runMs});
    }, ${hostWaitMs});
  `;
  return (_cmd, _args, opts) =>
    spawn(process.execPath, ['-e', script], {
      ...opts,
      shell: false,
      stdio: 'ignore',
    });
}

describe('suite-ready handshake (Story #5485)', {
  skip: process.platform === 'win32',
}, () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir('mandrel-ready-');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('suiteReadyHandshake names a fresh absolute path through the env', () => {
    const a = suiteReadyHandshake({ dir });
    const b = suiteReadyHandshake({ dir });
    assert.ok(path.isAbsolute(a.file));
    assert.notEqual(a.file, b.file);
    assert.deepEqual(a.env, { [SUITE_READY_FILE_ENV]: a.file });
    assert.equal(fs.existsSync(a.file), false);
  });

  // The pre-ready bound defaults to timeoutMs (production never moves it, so
  // a child that never signals dies exactly as before); it is lifted here so
  // the stub can wait out more than the whole test budget before signalling.
  it('AC-4: a host wait longer than timeoutMs is excluded, and hostWaitMs is reported', async () => {
    let timings = null;
    const code = await runCapture({
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      readyTimeoutMs: TIMEOUT_MS * 10,
      readyPollMs: POLL_MS,
      spawnImpl: stubSuite({ hostWaitMs: TIMEOUT_MS * 2, runMs: 100 }),
      onTimings: (t) => {
        timings = t;
      },
    });
    assert.equal(code, 0, 'the pre-ready wait did not spend the test budget');
    assert.ok(timings.hostWaitMs >= TIMEOUT_MS, JSON.stringify(timings));
    assert.ok(timings.testRunMs < TIMEOUT_MS, JSON.stringify(timings));
    assert.equal(timings.lockWaitMs, 0);
  });

  it('AC-4: a suite that never signals and outlives timeoutMs is killed with 124', async () => {
    let timings = null;
    const logs = [];
    const code = await runCapture({
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      readyPollMs: POLL_MS,
      spawnImpl: stubSuite({ runMs: TIMEOUT_MS * 5, signal: false }),
      log: (m) => logs.push(m),
      onTimings: (t) => {
        timings = t;
      },
    });
    assert.equal(code, TIMEOUT_EXIT_CODE);
    assert.equal(timings.hostWaitMs, null, 'no handshake, no host wait');
    assert.ok(logs.some((m) => /exceeded 1000ms/.test(m)));
  });

  it('AC-4: with the default pre-ready bound a host wait still spends at most timeoutMs', async () => {
    const code = await runCapture({
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      readyPollMs: POLL_MS,
      spawnImpl: stubSuite({ hostWaitMs: TIMEOUT_MS * 3, runMs: 50 }),
    });
    assert.equal(code, TIMEOUT_EXIT_CODE, 'the pre-ready phase is bounded');
  });

  it('AC-4: host wait plus test run may exceed timeoutMs when each phase fits', async () => {
    let timings = null;
    const code = await runCapture({
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      readyPollMs: POLL_MS,
      spawnImpl: stubSuite({ hostWaitMs: 600, runMs: 600 }),
      onTimings: (t) => {
        timings = t;
      },
    });
    assert.equal(code, 0);
    assert.ok(timings.hostWaitMs + timings.testRunMs > TIMEOUT_MS);
  });

  it('AC-4: the test phase is still bounded after the ready signal', async () => {
    const code = await runCapture({
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      readyPollMs: POLL_MS,
      spawnImpl: stubSuite({ hostWaitMs: 50, runMs: TIMEOUT_MS * 5 }),
    });
    assert.equal(code, TIMEOUT_EXIT_CODE);
  });

  it('AC-3: a lock wait longer than timeoutMs does not consume the test budget', async () => {
    const lockPath = path.join(dir, 'full-suite.lock');
    const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
    setTimeout(() => holder.release(), TIMEOUT_MS * 2);
    let timings = null;
    const capture = lockedCapture(
      runCapture,
      {},
      {},
      { lockPath, pollMs: POLL_MS, waitMs: 10_000 },
    );
    const code = await capture({
      cwd: dir,
      timeoutMs: TIMEOUT_MS,
      readyPollMs: POLL_MS,
      spawnImpl: stubSuite({ runMs: 100 }),
      onTimings: (t) => {
        timings = t;
      },
    });
    holder.release();
    assert.equal(code, 0);
    assert.ok(timings.lockWaitMs >= TIMEOUT_MS, JSON.stringify(timings));
    assert.ok(timings.testRunMs < TIMEOUT_MS, JSON.stringify(timings));
  });

  it('removes the ready file on release', async () => {
    const { file } = suiteReadyHandshake({ dir });
    const child = spawn(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, '')`],
      { stdio: 'ignore' },
    );
    const supervisor = superviseSuite(child, {
      timeoutMs: 5_000,
      readyFile: file,
      readyPollMs: POLL_MS,
    });
    await new Promise((resolve) => child.on('exit', resolve));
    supervisor.release();
    assert.notEqual(supervisor.timings.hostWaitMs, null);
    assert.equal(fs.existsSync(file), false);
  });

  it('AC-5: evidence-gate --gate test defers with 75 behind a live holder, spawning nothing', async () => {
    const lockPath = path.join(dir, 'full-suite.lock');
    const marker = path.join(dir, 'spawned');
    const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
    const lines = [];
    const code = await runLockedSuite(
      {
        cmd: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`,
        ],
        cwd: dir,
        log: (m) => lines.push(m),
      },
      { config: {}, lockOptions: { lockPath, waitMs: 0 } },
    );
    holder.release();
    assert.equal(code, LOCK_WAIT_EXPIRED_EXIT_CODE);
    assert.equal(fs.existsSync(marker), false, 'nothing was spawned');
    const expiry = lines.find((l) => l.includes('⌛')) ?? '';
    assert.match(expiry, new RegExp(`pid ${process.pid}, lock age \\d+s`));
    assert.match(expiry, /Re-run once it finishes: node /);
    assert.doesNotMatch(lines.join('\n'), /spawning anyway/);
  });

  it('AC-8: evidence-gate --gate test prints the three figures once the suite ran', async () => {
    const lines = [];
    const code = await runLockedSuite(
      {
        cmd: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: dir,
        log: (m) => lines.push(m),
      },
      {
        config: { delivery: { execution: { fullSuiteLock: false } } },
      },
    );
    assert.equal(code, 0);
    const timings = lines.map(parseSuiteTimings).find(Boolean);
    assert.ok(timings, lines.join('\n'));
    assert.equal(timings.lockWaitMs, 0);
    assert.equal(timings.hostWaitMs, null);
  });
});

describe('suite timing line (Story #5485)', () => {
  it('AC-8: formats three separate figures and parses them back', () => {
    const line = formatSuiteTimings({
      lockWaitMs: 1200.4,
      hostWaitMs: 300,
      testRunMs: 45_000,
    });
    assert.match(line, /lockWaitMs=1200 hostWaitMs=300 testRunMs=45000/);
    assert.deepEqual(parseSuiteTimings(`[coverage-capture] ${line}`), {
      lockWaitMs: 1200,
      hostWaitMs: 300,
      testRunMs: 45_000,
    });
  });

  it('prints n/a for a suite that did not use the handshake', () => {
    const line = formatSuiteTimings({
      lockWaitMs: 0,
      hostWaitMs: null,
      testRunMs: 10,
    });
    assert.match(line, /hostWaitMs=n\/a/);
    assert.equal(parseSuiteTimings(line).hostWaitMs, null);
    assert.equal(parseSuiteTimings('unrelated'), null);
  });
});

describe('branch coverage for the lock holder and the evidence-gate runner (Story #5485)', () => {
  it('readLockHolder reports unknowns for a missing or malformed lockfile', () => {
    const dir = makeTempDir('mandrel-holder-');
    try {
      const missing = readLockHolder(path.join(dir, 'none.lock'));
      assert.deepEqual(missing, { ownerId: null, pid: null, ageSeconds: null });
      const lockPath = path.join(dir, 'bad.lock');
      fs.writeFileSync(lockPath, 'owner-x\nnot-a-date\nnope\n');
      assert.deepEqual(readLockHolder(lockPath), {
        ownerId: 'owner-x',
        pid: null,
        ageSeconds: null,
      });
      fs.writeFileSync(
        lockPath,
        `owner-y\n${new Date(1_000).toISOString()}\n42\n`,
      );
      assert.deepEqual(readLockHolder(lockPath, { nowFn: () => 11_000 }), {
        ownerId: 'owner-y',
        pid: 42,
        ageSeconds: 10,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lockWaitPending names an unknown holder and omits an absent one', () => {
    const args = {
      storyId: 5485,
      storyBranch: 'story-5485',
      baseBranch: 'main',
      elapsedSeconds: 1,
    };
    const unknown = lockWaitPending({
      ...args,
      lockWait: {
        waitedSeconds: 1,
        expired: true,
        holder: { ownerId: null, pid: null, ageSeconds: null },
      },
    });
    assert.match(unknown.note, /unknown owner, pid unknown, lock age unknowns/);
    const absent = lockWaitPending({ ...args, lockWait: null });
    assert.match(absent.note, /another full suite held the host lock/);
  });

  it('runLockedSuite reports timings and a timeout through its log', async () => {
    const lines = [];
    const code = await runLockedSuite(
      {
        cmd: 'npm',
        args: ['test'],
        cwd: process.cwd(),
        log: (m) => lines.push(m),
      },
      {
        config: { delivery: { execution: { fullSuiteLock: false } } },
        runSuiteImpl: async (opts) => {
          opts.onTimings({ lockWaitMs: 0, hostWaitMs: 5, testRunMs: 9 });
          opts.onTimeout();
          return TIMEOUT_EXIT_CODE;
        },
      },
    );
    assert.equal(code, TIMEOUT_EXIT_CODE);
    assert.ok(lines.some((l) => /hostWaitMs=5 testRunMs=9/.test(l)));
    assert.ok(lines.some((l) => /exceeded 600000ms/.test(l)));
  });

  it('runEvidenceGate hands the test gate a logger-backed log', async () => {
    const infos = [];
    const out = await runEvidenceGate(
      {
        scopeId: 1,
        standalone: true,
        gate: 'test',
        useEvidence: false,
        cwd: process.cwd(),
        runnerArgs: ['npm', 'test'],
      },
      {
        logger: {
          info: (m) => infos.push(m),
          error: () => {},
          fatal: () => {},
        },
        runSuiteFn: async ({ log }) => {
          log('from the suite');
          return 0;
        },
      },
    );
    assert.equal(out.status, 0);
    assert.ok(infos.includes('from the suite'));
  });
});
