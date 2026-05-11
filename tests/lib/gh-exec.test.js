import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import exec, {
  GhExecError,
  GhExecTimeoutError,
} from '../../.agents/scripts/lib/gh-exec.js';

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
