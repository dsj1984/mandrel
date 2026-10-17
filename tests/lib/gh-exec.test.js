import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import exec, {
  GhExecError,
  GhExecTimeoutError,
  getSpawnCount,
  resetSpawnCount,
  runGh,
} from '../../.agents/scripts/lib/gh-exec.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/**
 * Build a fake `spawn` that drives the EventEmitter-shaped child the
 * production code listens on. The fake captures the args/opts it was called
 * with so assertions can verify "no shell, args as array".
 */
function makeFakeSpawn({
  stdout = '',
  stderr = '',
  code = 0,
  signal = null,
} = {}) {
  const calls = [];
  const fake = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    // Emit asynchronously so the production code can register listeners.
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      child.emit('close', code, signal);
    });
    return child;
  };
  return { fake, calls };
}

describe('gh-exec — JSON parse-through', () => {
  it('parses stdout as JSON when --json is in args', async () => {
    const payload = { number: 42, title: 'hello' };
    const { fake, calls } = makeFakeSpawn({
      stdout: JSON.stringify(payload),
    });
    const result = await exec({
      args: ['issue', 'view', '42', '--json', 'number,title'],
      spawnImpl: fake,
    });
    assert.deepEqual(result, payload);
    // Args passed as an array, no shell.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'gh');
    assert.ok(Array.isArray(calls[0].args));
    assert.equal(calls[0].opts.shell, false);
  });

  it('returns raw {stdout,stderr,code} when --json is absent', async () => {
    const { fake } = makeFakeSpawn({ stdout: 'plain text\n', code: 0 });
    const result = await exec({
      args: ['auth', 'status'],
      spawnImpl: fake,
    });
    assert.equal(result.stdout, 'plain text\n');
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
  });

  it('wraps JSON parse failures in GhExecError', async () => {
    const { fake } = makeFakeSpawn({ stdout: 'not json' });
    await assert.rejects(
      exec({
        args: ['issue', 'view', '1', '--json', 'number'],
        spawnImpl: fake,
      }),
      (err) => err instanceof GhExecError && /not valid JSON/.test(err.message),
    );
  });
});

describe('gh-exec — argument shape guard', () => {
  it('rejects when args is not an array', async () => {
    await assert.rejects(
      exec({ args: 'issue view 1', spawnImpl: () => {} }),
      (err) =>
        err instanceof GhExecError && /must be an array/.test(err.message),
    );
  });
});

describe('gh-exec — timeout surfacing', () => {
  it('rejects with GhExecTimeoutError when child is killed by spawn timeout', async () => {
    // Simulate Node's spawn-timeout behavior: code=null, signal='SIGTERM'.
    const { fake } = makeFakeSpawn({ code: null, signal: 'SIGTERM' });
    await assert.rejects(
      exec({
        args: ['repo', 'view', '--json', 'name'],
        timeoutMs: 50,
        spawnImpl: fake,
      }),
      (err) =>
        err instanceof GhExecTimeoutError &&
        err.timeoutMs === 50 &&
        /exceeded 50ms/.test(err.message),
    );
  });
});

describe('gh-exec — throw-away spawn counter (Story #1795)', () => {
  it('increments getSpawnCount on every successful spawn', async () => {
    resetSpawnCount();
    assert.equal(getSpawnCount(), 0);
    const { fake } = makeFakeSpawn({ stdout: '{"x":1}', code: 0 });
    await exec({
      args: ['issue', 'view', '1', '--json', 'x'],
      spawnImpl: fake,
    });
    assert.equal(getSpawnCount(), 1);
    await exec({
      args: ['issue', 'view', '2', '--json', 'x'],
      spawnImpl: fake,
    });
    assert.equal(getSpawnCount(), 2);
  });

  it('counts spawn attempts even when the child errors', async () => {
    resetSpawnCount();
    const { fake } = makeFakeSpawn({ stderr: 'boom', code: 1 });
    await assert.rejects(exec({ args: ['repo', 'view'], spawnImpl: fake }));
    assert.equal(getSpawnCount(), 1);
  });

  it('resetSpawnCount returns the counter to zero', async () => {
    const { fake } = makeFakeSpawn({ stdout: '', code: 0 });
    await exec({ args: ['auth', 'status'], spawnImpl: fake });
    assert.ok(getSpawnCount() >= 1);
    resetSpawnCount();
    assert.equal(getSpawnCount(), 0);
  });
});

describe('runGh captures through child-exec (Story #5756)', () => {
  const MIB = 1024 * 1024;
  const BIG = 'x'.repeat(2 * MIB);

  /** A `spawnSync`-shaped fake that fails ENOBUFS past its `maxBuffer`. */
  function bufferHonouringRunner(stdout) {
    const calls = [];
    const runner = (file, args, opts) => {
      calls.push({ file, args, opts });
      const limit = opts.maxBuffer ?? MIB;
      if (stdout.length > limit) {
        const error = Object.assign(new Error('spawnSync gh ENOBUFS'), {
          code: 'ENOBUFS',
        });
        return { status: null, stdout: stdout.slice(0, limit), error };
      }
      return { status: 0, stdout, stderr: '' };
    };
    return { runner, calls };
  }

  it('an injected runner receives the call under the shared ceiling', () => {
    const { runner, calls } = bufferHonouringRunner(BIG);
    const result = runGh(['api', 'big'], { cwd: '/repo' }, runner);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'gh');
    assert.deepEqual(calls[0].args, ['api', 'big']);
    assert.equal(calls[0].opts.cwd, '/repo');
    assert.equal(calls[0].opts.shell, false);
    assert.ok(calls[0].opts.maxBuffer > 1 * MIB);
    assert.equal(result.error, undefined);
    assert.equal(result.stdout.length, BIG.length);
  });

  it('a caller cannot reset the ceiling through its options', () => {
    const { runner, calls } = bufferHonouringRunner(BIG);
    runGh(['api', 'big'], { maxBuffer: MIB }, runner);
    assert.ok(calls[0].opts.maxBuffer >= MIB);
  });

  it('reads a gh child output larger than 1 MiB in full by default', {
    skip: process.platform === 'win32' && 'needs a POSIX gh stub on PATH',
  }, () => {
    const bin = makeTempDir('mandrel-rungh-big-');
    try {
      const stub = path.join(bin, 'gh');
      fs.writeFileSync(
        stub,
        `#!/bin/sh\nexec "${process.execPath}" -e "process.stdout.write('x'.repeat(${BIG.length}))"\n`,
      );
      fs.chmodSync(stub, 0o755);
      const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      };
      const result = runGh(['api', 'big'], { env });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.length, BIG.length);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
