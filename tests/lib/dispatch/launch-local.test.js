import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveEnvironments } from '../../../.agents/scripts/lib/dispatch/environments.js';
import {
  launchLocal,
  stopLocal,
} from '../../../.agents/scripts/lib/dispatch/launch-local.js';

describe('launchLocal', () => {
  it('spawns the argv array with {id} replaced and returns the record (AC-8)', async () => {
    const calls = [];
    const made = [];
    const [environment] = resolveEnvironments({});
    const record = await launchLocal(
      { storyId: 42, environment, cwd: 'proj', config: {} },
      {
        spawnImpl: async (file, args, opts) => {
          calls.push({ file, args, opts });
          return { pid: 1234 };
        },
        fsImpl: { mkdirSync: (dir) => made.push(dir) },
        now: () => new Date('2026-11-18T00:00:00Z'),
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'claude');
    assert.ok(Array.isArray(calls[0].args));
    assert.deepEqual(calls[0].args, ['-p', '/mandrel-deliver 42']);
    assert.equal(calls[0].opts.cwd, 'proj');
    assert.equal('shell' in calls[0].opts, false);
    assert.equal(path.basename(record.logPath), 'story-42.log');
    assert.equal(calls[0].opts.logPath, record.logPath);
    assert.deepEqual(made, [path.dirname(record.logPath)]);
    assert.deepEqual(record, {
      storyId: 42,
      environment: 'local',
      pid: 1234,
      startedAt: '2026-11-18T00:00:00.000Z',
      logPath: record.logPath,
      argv: ['claude', '-p', '/mandrel-deliver 42'],
    });
  });
});

describe('stopLocal', () => {
  const esrch = () => Object.assign(new Error('gone'), { code: 'ESRCH' });

  it('signals the process group first on POSIX', () => {
    const sent = [];
    const ok = stopLocal(10, {
      kill: (t, s) => sent.push([t, s]),
      platform: 'linux',
    });
    assert.equal(ok, true);
    assert.deepEqual(sent, [[-10, 'SIGTERM']]);
  });

  it('falls back to the pid when there is no group', () => {
    const sent = [];
    const kill = (t) => {
      sent.push(t);
      if (t < 0) throw esrch();
    };
    assert.equal(stopLocal(10, { kill, platform: 'darwin' }), true);
    assert.deepEqual(sent, [-10, 10]);
  });

  it('signals the pid only on Windows, and a gone process counts as stopped', () => {
    const sent = [];
    const kill = (t) => {
      sent.push(t);
      throw esrch();
    };
    assert.equal(stopLocal(10, { kill, platform: 'win32' }), false);
    assert.deepEqual(sent, [10]);
  });

  it('rethrows any other kill failure', () => {
    const kill = () => {
      throw Object.assign(new Error('nope'), { code: 'EPERM' });
    };
    assert.throws(() => stopLocal(10, { kill, platform: 'linux' }), /nope/);
  });
});
