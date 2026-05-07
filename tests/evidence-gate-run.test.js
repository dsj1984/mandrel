import assert from 'node:assert/strict';
import test from 'node:test';

import { runEvidenceGate } from '../.agents/scripts/evidence-gate.js';

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

function fakeGitSpawnHead(sha) {
  return () => ({ status: 0, stdout: `${sha}\n`, stderr: '' });
}

test('runEvidenceGate: skips runner when evidence verdict says skip', async () => {
  const logger = makeLogger();
  const spawnCalls = [];
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 817,
      epicId: 802,
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
      epicId: 802,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'test'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('abc1234567890abcdef0000000000000000fffff'),
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return { status: 0 };
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
      epicId: 802,
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
      epicId: 802,
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
      epicId: 802,
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

test('runEvidenceGate: missing epicId falls into fatal-usage path', async () => {
  const logger = makeLogger();
  const out = await runEvidenceGate(
    {
      scopeId: 901,
      epicId: null,
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
      epicId: 1,
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
      epicId: 1,
      gate: 'test',
      useEvidence: true,
      cwd: '/repo',
      runnerArgs: ['npm', 'test'],
    },
    {
      gitSpawnFn: fakeGitSpawnHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      spawnFn: () => ({ status: 0 }),
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

test('runEvidenceGate: HEAD-resolution failure bypasses evidence (no skip, no record)', async () => {
  const logger = makeLogger();
  const recordCalls = [];

  const out = await runEvidenceGate(
    {
      scopeId: 1,
      epicId: 1,
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
