import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  runEvidenceGate,
  runLockedSuite,
} from '../.agents/scripts/evidence-gate.js';
import { createLockEventChannel } from '../.agents/scripts/lib/close-lock-events.js';
import { acquireSweepLock } from '../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import { hashCommandConfig } from '../.agents/scripts/lib/validation-evidence.js';

/**
 * Unit tests for the extracted `runEvidenceGate` runner. Drives the runner
 * directly with stubbed `gitSpawn` / `spawnSync` / evidence store so the
 * tests exercise only the orchestration logic — no disk, no child
 * processes, no real validation-evidence file.
 *
 * Companion to tests/evidence-gate.test.js (which covers `splitOnDashDash`
 * + `parseWrapperArgs` argv shaping).
 */

function makeLogger() {
  const calls = { info: [], warn: [], error: [], fatal: [] };
  return {
    calls,
    info: (m) => calls.info.push(m),
    warn: (m) => calls.warn.push(m),
    error: (m) => calls.error.push(m),
    fatal: (m) => {
      calls.fatal.push(m);
    },
  };
}

function fakeGitSpawnHead(sha, porcelain = '') {
  return (_cwd, verb) =>
    verb === 'status'
      ? { status: 0, stdout: porcelain, stderr: '' }
      : { status: 0, stdout: `${sha}\n`, stderr: '' };
}

async function runDirty(gitSpawnFn) {
  const logger = makeLogger();
  const calls = { spawn: 0, skip: 0, record: 0 };
  const out = await runEvidenceGate(
    {
      scopeId: 6070,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn,
      spawnFn: () => {
        calls.spawn += 1;
        return { status: 0 };
      },
      shouldSkipFn: () => {
        calls.skip += 1;
        return { skip: true };
      },
      recordPassFn: () => {
        calls.record += 1;
      },
      logger,
    },
  );
  return { out, calls, logger };
}

for (const porcelain of ['?? new-helper.ts', ' M a.ts', 'M a.ts']) {
  test(`runEvidenceGate: a dirty tree (${JSON.stringify(porcelain)}) runs the gate without consulting or recording evidence`, async () => {
    const { out, calls, logger } = await runDirty(
      fakeGitSpawnHead('e'.repeat(40), porcelain),
    );
    assert.deepEqual(out, { status: 0, skipped: false });
    assert.deepEqual(calls, { spawn: 1, skip: 0, record: 0 });
    const first = porcelain.replace(/^\s*\S+\s/, '');
    const bypass = logger.calls.info.filter((m) => /evidence bypassed/.test(m));
    assert.equal(bypass.length, 1);
    assert.match(bypass[0], new RegExp(`${first}, 1 changed`));
  });
}

for (const [label, probe] of [
  ['exits non-zero', () => ({ status: 128, stdout: '', stderr: 'boom' })],
  [
    'throws',
    () => {
      throw new Error('spawn failed');
    },
  ],
]) {
  test(`runEvidenceGate: a status probe that ${label} bypasses evidence`, async () => {
    const head = fakeGitSpawnHead('e'.repeat(40));
    const { out, calls, logger } = await runDirty((cwd, verb, ...rest) =>
      verb === 'status' ? probe() : head(cwd, verb, ...rest),
    );
    assert.deepEqual(out, { status: 0, skipped: false });
    assert.deepEqual(calls, { spawn: 1, skip: 0, record: 0 });
    assert.ok(
      logger.calls.info.some((m) =>
        /bypassed \(git status probe failed\)/.test(m),
      ),
    );
  });
}

test('runEvidenceGate: skips runner when evidence verdict says skip', async () => {
  const logger = makeLogger();
  const spawnCalls = [];
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 817,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('deadbeefcafebabe1234567890abcdef12345678'),
      spawnFn: (...args) => {
        spawnCalls.push(args);
        return { status: 0 };
      },
      shouldSkipFn: () => ({
        skip: true,
        record: { timestamp: '2026-05-02T10:00:00Z' },
      }),
      recordPassFn: (...args) => {
        recordCalls.push(args);
      },
      logger,
    },
  );

  assert.deepEqual(out, { status: 0, skipped: true });
  assert.equal(
    spawnCalls.length,
    0,
    'spawn must not run when evidence skips the gate',
  );
  assert.equal(
    recordCalls.length,
    0,
    'recordPass must not run when the gate is skipped',
  );
  assert.ok(
    logger.calls.info.some((m) => /skipped/.test(m) && /lint/.test(m)),
    'logs a skip line for the gate',
  );
});

test('runEvidenceGate: runs the runner and records evidence on pass', async () => {
  const logger = makeLogger();
  const spawnCalls = [];
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 817,
      standalone: true,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'test'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('abc1234567890abcdef0000000000000000fffff'),
      spawnFn: () => {
        throw new Error('the test gate runs through runSuiteFn');
      },
      runSuiteFn: async (run) => {
        spawnCalls.push({ cmd: run.cmd, args: run.args, opts: run });
        return 0;
      },
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: (rec) => {
        recordCalls.push(rec);
      },
      logger,
    },
  );

  assert.deepEqual(out, { status: 0, skipped: false });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'npm');
  assert.deepEqual(spawnCalls[0].args, ['test']);
  assert.equal(spawnCalls[0].opts.cwd, '/repo');
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].storyId, 817);
  assert.equal(recordCalls[0].gateName, 'test');
  assert.equal(recordCalls[0].exitCode, 0);
  assert.ok(
    logger.calls.info.some((m) => /passed/.test(m)),
    'logs a pass line',
  );
});

test('runEvidenceGate: failing runner does NOT record evidence', async () => {
  const logger = makeLogger();
  const recordCalls = [];
  const priorExitCode = process.exitCode;

  const out = await runEvidenceGate(
    {
      scopeId: 901,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('1111111111111111111111111111111111111111'),
      spawnFn: () => ({ status: 2 }),
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: (rec) => {
        recordCalls.push(rec);
      },
      logger,
    },
  );

  assert.equal(out.status, 2);
  assert.equal(out.skipped, false);
  assert.equal(
    recordCalls.length,
    0,
    'recordPass must not fire on a failing gate',
  );
  assert.ok(
    logger.calls.error.some((m) => /failed/.test(m)),
    'logs the failure',
  );
  // Restore the global exitCode the runner mutates as a side-effect of
  // mirroring the runner's exit code; otherwise the test runner returns
  // non-zero even though every assertion passed.
  process.exitCode = priorExitCode;
});

test('runEvidenceGate: --no-evidence path skips both shouldSkip and recordPass', async () => {
  const logger = makeLogger();
  const shouldSkipCalls = [];
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 901,
      standalone: true,
      gate: 'lint',
      useEvidence: false,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      // gitSpawnFn must NOT be called when useEvidence is false; trip if it is.
      gitSpawnFn: () => {
        throw new Error('gitSpawn must not be invoked with --no-evidence');
      },
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: (...args) => {
        shouldSkipCalls.push(args);
        return { skip: false };
      },
      recordPassFn: (...args) => {
        recordCalls.push(args);
      },
      logger,
    },
  );

  assert.deepEqual(out, { status: 0, skipped: false });
  assert.equal(
    shouldSkipCalls.length,
    0,
    'shouldSkip must be bypassed when --no-evidence is set',
  );
  assert.equal(
    recordCalls.length,
    0,
    'recordPass must be bypassed when --no-evidence is set',
  );
});

test('runEvidenceGate: missing scopeId falls into fatal-usage path', async () => {
  const logger = makeLogger();
  const out = await runEvidenceGate(
    {
      scopeId: null,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: () => {},
      logger,
    },
  );
  assert.equal(out.status, 1);
  assert.equal(out.skipped, false);
  assert.equal(logger.calls.fatal.length, 1);
});

test('runEvidenceGate: empty runnerArgs falls into fatal-usage path', async () => {
  const logger = makeLogger();
  const out = await runEvidenceGate(
    {
      scopeId: 1,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: [],
    },
    {
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: () => {},
      logger,
    },
  );
  assert.equal(out.status, 1);
  assert.equal(logger.calls.fatal.length, 1);
});

test('runEvidenceGate: recordPass exception is swallowed (gate still passes)', async () => {
  const logger = makeLogger();
  const out = await runEvidenceGate(
    {
      scopeId: 1,
      standalone: true,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'test'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      runSuiteFn: async () => 0,
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: () => {
        throw new Error('disk full');
      },
      logger,
    },
  );
  assert.deepEqual(out, { status: 0, skipped: false });
  assert.ok(
    logger.calls.warn.some((m) => /failed to record evidence/.test(m)),
    'warns on record-failure but still returns pass',
  );
});

test('runEvidenceGate: --standalone records into the storyId-anchored keyspace (Story #4250)', async () => {
  const logger = makeLogger();
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 4250,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-4250',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('cccccccccccccccccccccccccccccccccccccccc'),
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: (rec, opts) => {
        recordCalls.push({ rec, opts });
      },
      logger,
    },
  );

  assert.deepEqual(out, { status: 0, skipped: false });
  assert.equal(recordCalls.length, 1, 'standalone path records evidence');
  assert.equal(recordCalls[0].rec.storyId, 4250);
  assert.equal(recordCalls[0].rec.gateName, 'lint');
  // The evidence-store opts must carry standalone:true so recordPass routes
  // to the storyId-anchored keyspace.
  assert.equal(recordCalls[0].opts.standalone, true);
});

test('runEvidenceGate: --standalone shouldSkip is called with standalone store opts', async () => {
  const logger = makeLogger();
  const shouldSkipCalls = [];

  await runEvidenceGate(
    {
      scopeId: 4250,
      standalone: true,
      gate: 'typecheck',
      useEvidence: true,
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-4250',
      runnerArgs: ['npm', 'run', 'typecheck'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('dddddddddddddddddddddddddddddddddddddddd'),
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: (input, opts) => {
        shouldSkipCalls.push({ input, opts });
        return { skip: false };
      },
      recordPassFn: () => {},
      logger,
    },
  );

  assert.equal(shouldSkipCalls.length, 1);
  assert.equal(shouldSkipCalls[0].opts.standalone, true);
  assert.equal(shouldSkipCalls[0].input.gateName, 'typecheck');
});

test('runEvidenceGate: missing standalone falls into fatal-usage path', async () => {
  const logger = makeLogger();
  const out = await runEvidenceGate(
    {
      scopeId: 901,
      standalone: false,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: () => {},
      logger,
    },
  );
  assert.equal(out.status, 1);
  assert.equal(logger.calls.fatal.length, 1);
});

test('runEvidenceGate: HEAD-resolution failure bypasses evidence (no skip, no record)', async () => {
  const logger = makeLogger();
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 1,
      standalone: true,
      gate: 'lint',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'run', 'lint'],
    },
    {
      gitSpawnFn: () => ({ status: 128, stdout: '', stderr: 'not a repo' }),
      spawnFn: () => ({ status: 0 }),
      shouldSkipFn: () => {
        throw new Error('shouldSkip must not run when HEAD is unresolved');
      },
      recordPassFn: (...args) => {
        recordCalls.push(args);
      },
      logger,
    },
  );

  assert.deepEqual(out, { status: 0, skipped: false });
  assert.equal(
    recordCalls.length,
    0,
    'recordPass must not run when HEAD did not resolve',
  );
});

test('runEvidenceGate: a deferred test gate (exit 75) records nothing and says why (Story #5485)', async () => {
  const logger = makeLogger();
  const recordCalls = [];
  const priorExitCode = process.exitCode;
  const out = await runEvidenceGate(
    {
      scopeId: 5485,
      standalone: true,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'test'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      runSuiteFn: async () => 75,
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: (rec) => recordCalls.push(rec),
      logger,
    },
  );
  process.exitCode = priorExitCode;
  assert.deepEqual(out, { status: 75, skipped: false });
  assert.equal(recordCalls.length, 0);
  assert.ok(logger.calls.info.some((m) => /deferred \(exit 75\)/.test(m)));
});

test('runEvidenceGate: a test gate that lost workers (exit 77) logs host resources, not failed (Story #5959)', async () => {
  const logger = makeLogger();
  const recordCalls = [];
  const priorExitCode = process.exitCode;
  const out = await runEvidenceGate(
    {
      scopeId: 5959,
      standalone: true,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'test'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      runSuiteFn: async () => 77,
      shouldSkipFn: () => ({ skip: false }),
      recordPassFn: (rec) => recordCalls.push(rec),
      logger,
    },
  );
  process.exitCode = priorExitCode;
  assert.deepEqual(out, { status: 77, skipped: false });
  assert.equal(recordCalls.length, 0);
  assert.ok(logger.calls.error.some((m) => /host memory \(exit 77\)/.test(m)));
  assert.ok(!logger.calls.error.some((m) => /failed \(exit 77\)/.test(m)));
});

for (const status of [75, 77]) {
  test(`runEvidenceGate: a non-suite gate's exit ${status} is an ordinary failure`, async () => {
    const logger = makeLogger();
    const priorExitCode = process.exitCode;
    const out = await runEvidenceGate(
      {
        scopeId: 1,
        standalone: true,
        gate: 'lint',
        useEvidence: true,
        cwd: '/repo',
        runnerArgs: ['npm', 'run', 'lint'],
      },
      {
        gitSpawnFn: fakeGitSpawnHead(
          'cccccccccccccccccccccccccccccccccccccccc',
        ),
        spawnFn: () => ({ status }),
        shouldSkipFn: () => ({ skip: false }),
        recordPassFn: () => {},
        logger,
      },
    );
    process.exitCode = priorExitCode;
    assert.deepEqual(out, { status, skipped: false });
    const failed = new RegExp(`lint failed \\(exit ${status}\\)`);
    assert.ok(logger.calls.error.some((m) => failed.test(m)));
    const all = [...logger.calls.info, ...logger.calls.error];
    assert.ok(!all.some((m) => /deferred|host memory/.test(m)));
  });
}

// Story #5662 — the gate's lock wait streams `lock-progress` events onto the
// claimed channel, beside the `lock-wait` outcome close already reads.
test('runLockedSuite: emits lock-progress on the claimed channel while it waits', async () => {
  const dir = makeTempDir('mandrel-eg-progress-');
  try {
    const lockPath = path.join(dir, 'full-suite.lock');
    const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
    const channel = createLockEventChannel({ dir });
    const expiredCode = await runLockedSuite(
      { cmd: 'npm', args: ['test'], cwd: dir, log: () => {} },
      {
        config: {},
        env: { ...channel.env },
        lockOptions: { lockPath, waitMs: 0 },
        runSuiteImpl: async () => 0,
      },
    );
    assert.equal(expiredCode, 75);
    const expired = channel.drain();
    assert.deepEqual(
      expired.map((e) => [e.kind, e.phase]),
      [
        ['lock-progress', 'waiting'],
        ['lock-progress', 'expired'],
        ['lock-wait', undefined],
      ],
    );
    assert.equal(expired[0].holder.ownerId, holder.ownerId);

    let spawned = 0;
    const acquiredCode = await runLockedSuite(
      { cmd: 'npm', args: ['test'], cwd: dir, log: () => {} },
      {
        config: {},
        env: { ...channel.env },
        lockOptions: {
          lockPath,
          sleepFn: async () => holder.release(),
        },
        runSuiteImpl: async () => {
          spawned += 1;
          return 0;
        },
      },
    );
    assert.equal(acquiredCode, 0);
    assert.equal(spawned, 1);
    assert.deepEqual(
      channel.drain().map((e) => [e.kind, e.phase]),
      [
        ['lock-progress', 'waiting'],
        ['lock-progress', 'admitted'],
        ['lock-wait', undefined],
        ['lock-progress', 'completed'],
      ],
    );
    channel.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Story #5961 — the skip-branch scoped deposit.
const SINCE = 'e'.repeat(40);
const SCOPED_CONFIG = { project: { commands: { test: 'npm run test:all' } } };

for (const [label, gate, since] of [
  ['the gate is not test', 'lint', SINCE],
  ['the value is not a hex sha', 'test', 'origin/main'],
  ['the value is empty', 'test', ''],
]) {
  test(`runEvidenceGate: --changed-since refuses when ${label} and spawns nothing`, async () => {
    const logger = makeLogger();
    let spawned = 0;
    const out = await runEvidenceGate(
      {
        scopeId: 5961,
        standalone: true,
        gate,
        useEvidence: true,
        cwd: '/repo',
        runnerArgs: ['pnpm', 'vitest'],
        changedSince: since,
      },
      {
        gitSpawnFn: () => {
          spawned += 1;
          return { status: 0, stdout: SINCE };
        },
        spawnFn: () => {
          spawned += 1;
          return { status: 0 };
        },
        runSuiteFn: async () => {
          spawned += 1;
          return 0;
        },
        logger,
      },
    );
    assert.deepEqual(out, { status: 1, skipped: false });
    assert.equal(spawned, 0);
    assert.match(logger.calls.fatal.join('\n'), /--changed-since/);
  });
}

test('runEvidenceGate: --changed-since runs the substituted argv with the env and credits the full-suite identity', async () => {
  const logger = makeLogger();
  const runs = [];
  const records = [];
  const skips = [];
  const out = await runEvidenceGate(
    {
      scopeId: 5961,
      standalone: true,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-5961',
      runnerArgs: ['pnpm', 'vitest', '--changed', '$MANDREL_CHANGED_SINCE'],
      changedSince: SINCE,
    },
    {
      gitSpawnFn: fakeGitSpawnHead('f'.repeat(40)),
      runSuiteFn: async (run) => {
        runs.push(run);
        return 0;
      },
      shouldSkipFn: (q) => {
        skips.push(q);
        return { skip: false };
      },
      recordPassFn: (rec) => records.push(rec),
      loadConfigFn: () => SCOPED_CONFIG,
      logger,
    },
  );
  assert.deepEqual(out, { status: 0, skipped: false });
  assert.deepEqual(runs[0].args, ['vitest', '--changed', SINCE]);
  assert.deepEqual(runs[0].childEnv, { MANDREL_CHANGED_SINCE: SINCE });
  // Close's runner hashes its `test` gate on the raw spawn cwd.
  const fullIdentity = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'test:all'],
    cwd: '/repo/.worktrees/story-5961',
  });
  assert.equal(skips[0].configHash, fullIdentity);
  assert.equal(records[0].configHash, fullIdentity);
  assert.equal(records[0].scope, 'delta');
  assert.equal(records[0].since, SINCE);
  assert.ok(logger.calls.info.some((m) => /✓ test passed/.test(m)));
});

test('runLockedSuite: a child env reaches the suite beside the lock env', async () => {
  const dir = makeTempDir('mandrel-eg-childenv-');
  try {
    let seen = null;
    const code = await runLockedSuite(
      {
        cmd: 'npm',
        args: ['test'],
        cwd: dir,
        log: () => {},
        childEnv: { MANDREL_CHANGED_SINCE: SINCE },
      },
      {
        config: {},
        env: {},
        lockOptions: { lockPath: path.join(dir, 'full-suite.lock') },
        runSuiteImpl: async (opts) => {
          seen = opts.env;
          return 0;
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(seen.MANDREL_CHANGED_SINCE, SINCE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
