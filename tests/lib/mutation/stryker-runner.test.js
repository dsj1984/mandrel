import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_REPORT_PATH,
  DEFAULT_TIMEOUT_MS,
  runStryker,
  summariseReport,
} from '../../../.agents/scripts/lib/mutation/stryker-runner.js';

/**
 * Story #1736 / Task #1754. Unit coverage for the Stryker invocation
 * wrapper and the report summariser. The runner is exercised through an
 * injected `spawnFn` shim plus an in-memory fs surface so no Stryker
 * binary is invoked.
 */

function makeFsShim(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    existsSync(p) {
      return store.has(p);
    },
    readFileSync(p) {
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
  };
}

describe('mutation/stryker-runner — summariseReport', () => {
  it('prefers the precomputed metrics.mutationScore when present', () => {
    const result = summariseReport(
      { metrics: { mutationScore: 78.5 }, files: {} },
      { workspace: '*' },
    );
    assert.deepEqual(result, {
      ok: true,
      mutationScore: 78.5,
      byWorkspace: { '*': 78.5 },
    });
  });

  it('computes the score from the files map when metrics is absent', () => {
    const report = {
      files: {
        'src/a.js': {
          mutants: [
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Killed' },
            { status: 'Survived' },
          ],
        },
        'src/b.js': {
          mutants: [{ status: 'Killed' }, { status: 'NoCoverage' }],
        },
      },
    };
    const result = summariseReport(report);
    assert.equal(result.ok, true);
    // 4 killed out of 6 total = 66.67
    assert.equal(result.mutationScore, 66.67);
    assert.deepEqual(result.byWorkspace, { '*': 66.67 });
  });

  it('rejects non-object report payloads', () => {
    assert.equal(summariseReport(null).ok, false);
    assert.equal(summariseReport([]).ok, false);
    assert.equal(summariseReport('hi').ok, false);
  });

  it("rejects a report missing the 'files' map", () => {
    const result = summariseReport({});
    assert.equal(result.ok, false);
    assert.match(result.error, /files/);
  });

  it('rejects a report with no scored mutants', () => {
    const result = summariseReport({ files: {} });
    assert.equal(result.ok, false);
    assert.match(result.error, /no scored mutants/);
  });

  it('honours the workspace label in byWorkspace', () => {
    const result = summariseReport(
      { metrics: { mutationScore: 80 } },
      { workspace: 'api' },
    );
    assert.deepEqual(result.byWorkspace, { api: 80 });
  });
});

describe('mutation/stryker-runner — runStryker', () => {
  it('returns parsed score when Stryker exits 0 and report exists', async () => {
    const reportAbs = path.resolve('/repo', DEFAULT_REPORT_PATH);
    const fsImpl = makeFsShim({
      [reportAbs]: JSON.stringify({ metrics: { mutationScore: 85.5 } }),
    });
    const spawnFn = () => ({
      status: 0,
      signal: null,
      stdout: 'Stryker finished.',
      stderr: '',
      error: null,
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      skipDetect: true,
      clock: (() => {
        let t = 1000;
        return () => {
          const v = t;
          t += 500;
          return v;
        };
      })(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.mutationScore, 85.5);
    assert.deepEqual(result.byWorkspace, { '*': 85.5 });
    assert.equal(result.reportPath, reportAbs);
    assert.equal(result.durationMs, 500);
  });

  it('returns error when Stryker exits non-zero', async () => {
    const fsImpl = makeFsShim();
    const spawnFn = () => ({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'oops',
      error: null,
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(result.error, /status 1/);
  });

  it('returns error when the report is missing', async () => {
    const fsImpl = makeFsShim();
    const spawnFn = () => ({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: null,
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /report not found/);
  });

  it('returns error when the report is malformed JSON', async () => {
    const reportAbs = path.resolve('/repo', DEFAULT_REPORT_PATH);
    const fsImpl = makeFsShim({ [reportAbs]: '{not json' });
    const spawnFn = () => ({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: null,
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /failed to parse/);
  });

  it('respects an explicit configPath and surfaces it as --configFile', async () => {
    const captured = [];
    const spawnFn = (cmd, args) => {
      captured.push({ cmd, args });
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
      };
    };
    const reportAbs = path.resolve('/repo', DEFAULT_REPORT_PATH);
    const fsImpl = makeFsShim({
      [reportAbs]: JSON.stringify({ metrics: { mutationScore: 70 } }),
    });
    await runStryker({
      cwd: '/repo',
      configPath: '/repo/stryker.conf.js',
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].args, [
      'stryker',
      'run',
      '--configFile',
      '/repo/stryker.conf.js',
    ]);
  });

  it('surfaces a timeout failure when spawnSync reports SIGTERM', async () => {
    const fsImpl = makeFsShim();
    const spawnFn = () => ({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      error: null,
    });
    const result = await runStryker({
      cwd: '/repo',
      timeoutMs: 1000,
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 1000ms/);
  });

  it('surfaces an ETIMEDOUT error from spawnSync', async () => {
    const fsImpl = makeFsShim();
    const err = new Error('boom');
    err.code = 'ETIMEDOUT';
    const spawnFn = () => ({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: err,
    });
    const result = await runStryker({
      cwd: '/repo',
      timeoutMs: 1000,
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
  });

  it('surfaces a generic spawn error', async () => {
    const fsImpl = makeFsShim();
    const err = new Error('no such binary');
    const spawnFn = () => ({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: err,
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /failed to invoke Stryker/);
  });

  it('honours a per-gate timeoutMs override over the default', async () => {
    const captured = [];
    const spawnFn = (cmd, args, opts) => {
      captured.push(opts);
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
      };
    };
    const reportAbs = path.resolve('/repo', DEFAULT_REPORT_PATH);
    const fsImpl = makeFsShim({
      [reportAbs]: JSON.stringify({ metrics: { mutationScore: 80 } }),
    });
    await runStryker({
      cwd: '/repo',
      timeoutMs: 5000,
      spawnFn,
      fsImpl,
      skipDetect: true,
    });
    assert.equal(captured[0].timeout, 5000);
  });

  it('falls back to DEFAULT_TIMEOUT_MS when not supplied', async () => {
    const captured = [];
    const spawnFn = (cmd, args, opts) => {
      captured.push(opts);
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
      };
    };
    const reportAbs = path.resolve('/repo', DEFAULT_REPORT_PATH);
    const fsImpl = makeFsShim({
      [reportAbs]: JSON.stringify({ metrics: { mutationScore: 80 } }),
    });
    await runStryker({ cwd: '/repo', spawnFn, fsImpl, skipDetect: true });
    assert.equal(captured[0].timeout, DEFAULT_TIMEOUT_MS);
  });

  it('returns { skipped: true, reason } when no Stryker config is detected', async () => {
    const fsImpl = makeFsShim();
    const spawnFn = () => {
      throw new Error('spawn should not be called when detection fails');
    };
    const detectFn = () => ({
      found: false,
      via: null,
      path: null,
      reason: 'no Stryker config found',
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      detectFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /no Stryker config/);
  });

  it('runs Stryker against the detected config path when detection succeeds', async () => {
    const captured = [];
    const spawnFn = (cmd, args) => {
      captured.push({ cmd, args });
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
      };
    };
    const reportAbs = path.resolve('/repo', DEFAULT_REPORT_PATH);
    const fsImpl = makeFsShim({
      [reportAbs]: JSON.stringify({ metrics: { mutationScore: 80 } }),
    });
    const detectFn = () => ({
      found: true,
      via: 'config-file',
      path: '/repo/stryker.conf.js',
    });
    const result = await runStryker({
      cwd: '/repo',
      spawnFn,
      fsImpl,
      detectFn,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(captured[0].args, [
      'stryker',
      'run',
      '--configFile',
      '/repo/stryker.conf.js',
    ]);
  });
});
