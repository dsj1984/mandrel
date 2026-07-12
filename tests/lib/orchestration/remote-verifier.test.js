/**
 * tests/lib/orchestration/remote-verifier.test.js — issue #4483.
 *
 * Unit tests for the deterministic remote-evidence probes that back the
 * `/deliver` land-or-block entry contract:
 *
 *   - `verifyRemote` — `git remote get-url origin` + bounded
 *     `git ls-remote origin HEAD`; `remoteVerified` is true only when
 *     BOTH succeed.
 *   - `probeRemoteBranch` — the finalize backstop's "is the delivery
 *     branch actually on origin?" probe.
 *
 * The git boundary is injected (`spawnFn`) so no test touches a real
 * remote, mirroring how the finalizer's `ghPrListHead` probe is stubbed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  probeRemoteBranch,
  REMOTE_PROBE_TIMEOUT_MS,
  verifyRemote,
} from '../../../.agents/scripts/lib/orchestration/remote-verifier.js';

/**
 * Build a spawnFn stub that dispatches on the git subcommand and records
 * every invocation (args + options) for spawn-contract assertions.
 */
function makeSpawnStub(responses) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = args[0]; // 'remote' | 'ls-remote'
    const res = responses[key] ?? { status: 1, stdout: '', stderr: 'no stub' };
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  return { spawnFn, calls };
}

describe('verifyRemote', () => {
  it('verifies when origin is configured and ls-remote answers', () => {
    const { spawnFn, calls } = makeSpawnStub({
      remote: {
        status: 0,
        stdout: 'https://github.com/o/r.git\n',
        stderr: '',
      },
      'ls-remote': {
        status: 0,
        stdout: 'abc123\tHEAD\n',
        stderr: '',
      },
    });
    const result = verifyRemote({ cwd: '/tmp/repo', spawnFn });
    assert.equal(result.remoteVerified, true);
    assert.equal(result.remoteUrl, 'https://github.com/o/r.git');
    assert.match(result.detail, /origin verified/);
    assert.match(result.detail, /abc123/);
    // Both probes ran, in order, bounded and shell-free.
    assert.deepEqual(
      calls.map((c) => c.args),
      [
        ['remote', 'get-url', 'origin'],
        ['ls-remote', 'origin', 'HEAD'],
      ],
    );
    for (const c of calls) {
      assert.equal(c.cmd, 'git');
      assert.equal(c.opts.shell, false);
      assert.equal(c.opts.timeout, REMOTE_PROBE_TIMEOUT_MS);
      assert.equal(c.opts.killSignal, 'SIGKILL');
      assert.equal(c.opts.cwd, '/tmp/repo');
    }
  });

  it('fails with no-origin detail (and skips ls-remote) when no origin is configured', () => {
    const { spawnFn, calls } = makeSpawnStub({
      remote: {
        status: 2,
        stdout: '',
        stderr: "error: No such remote 'origin'",
      },
    });
    const result = verifyRemote({ cwd: '/tmp/repo', spawnFn });
    assert.equal(result.remoteVerified, false);
    assert.equal(result.remoteUrl, null);
    assert.match(result.detail, /no 'origin' remote configured/);
    assert.match(result.detail, /No such remote/);
    assert.equal(result.probes.lsRemote, null);
    assert.equal(calls.length, 1);
  });

  it('fails with unreachable detail when ls-remote exits non-zero', () => {
    const { spawnFn } = makeSpawnStub({
      remote: { status: 0, stdout: 'git@github.com:o/r.git\n', stderr: '' },
      'ls-remote': { status: 128, stdout: '', stderr: 'fatal: could not read' },
    });
    const result = verifyRemote({ cwd: '/x', spawnFn });
    assert.equal(result.remoteVerified, false);
    assert.equal(result.remoteUrl, 'git@github.com:o/r.git');
    assert.match(result.detail, /unreachable/);
    assert.match(result.detail, /could not read/);
  });

  it('fails when ls-remote succeeds but returns no output (killed at the timeout bound)', () => {
    // spawnSync reports a SIGKILLed child as status null → normalized 1,
    // but even a status-0 empty answer must not verify.
    const { spawnFn } = makeSpawnStub({
      remote: { status: 0, stdout: 'https://github.com/o/r.git', stderr: '' },
      'ls-remote': { status: 0, stdout: '', stderr: '' },
    });
    const result = verifyRemote({ cwd: '/x', spawnFn });
    assert.equal(result.remoteVerified, false);
    assert.match(result.detail, /empty ls-remote output/);
  });
});

describe('probeRemoteBranch', () => {
  it('reports exists with the remote SHA when the ref is on origin', () => {
    const { spawnFn, calls } = makeSpawnStub({
      'ls-remote': {
        status: 0,
        stdout: 'def456\trefs/heads/epic/7\n',
        stderr: '',
      },
    });
    const result = probeRemoteBranch({
      branch: 'epic/7',
      cwd: '/tmp/repo',
      spawnFn,
    });
    assert.equal(result.exists, true);
    assert.match(result.detail, /def456/);
    assert.deepEqual(calls[0].args, [
      'ls-remote',
      '--heads',
      'origin',
      'epic/7',
    ]);
    assert.equal(calls[0].opts.timeout, REMOTE_PROBE_TIMEOUT_MS);
  });

  it('reports never-pushed when ls-remote answers with no ref', () => {
    const { spawnFn } = makeSpawnStub({
      'ls-remote': { status: 0, stdout: '', stderr: '' },
    });
    const result = probeRemoteBranch({ branch: 'epic/7', cwd: '/x', spawnFn });
    assert.equal(result.exists, false);
    assert.match(result.detail, /never pushed/);
  });

  it('reports the probe failure detail when ls-remote exits non-zero', () => {
    const { spawnFn } = makeSpawnStub({
      'ls-remote': { status: 128, stdout: '', stderr: 'fatal: no remote' },
    });
    const result = probeRemoteBranch({ branch: 'epic/7', cwd: '/x', spawnFn });
    assert.equal(result.exists, false);
    assert.match(result.detail, /fatal: no remote/);
  });

  it('rejects an empty branch', () => {
    assert.throws(
      () => probeRemoteBranch({ branch: '', cwd: '/x' }),
      /non-empty string/,
    );
  });
});
