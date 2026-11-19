import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveEnvironments } from '../../../.agents/scripts/lib/dispatch/environments.js';
import {
  launchLocal,
  stopLocal,
} from '../../../.agents/scripts/lib/dispatch/launch-local.js';
import { gateLaunch } from '../../../.agents/scripts/lib/dispatch/launch-options.js';
import {
  readRecord,
  writeRecord,
} from '../../../.agents/scripts/lib/dispatch/record.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

/** The environment dispatch launches: `config`'s `local` entry, its options filled. */
function launchEnvironment(config = {}, labels = []) {
  const verdict = { ok: true, action: 'dispatch', environment: 'local' };
  const environments = resolveEnvironments(config);
  return gateLaunch(verdict, environments, { labels }, config).launch
    .environment;
}

function launch(environment, uuid = () => 'sess-1') {
  const calls = [];
  const made = [];
  const promise = launchLocal(
    { storyId: 42, environment, cwd: 'proj', config: {} },
    {
      spawnImpl: async (file, args, opts) => {
        calls.push({ file, args, opts });
        return { pid: 1234 };
      },
      fsImpl: { mkdirSync: (dir) => made.push(dir) },
      now: () => new Date('2026-11-18T00:00:00Z'),
      uuid,
    },
  );
  return promise.then((record) => ({ record, calls, made }));
}

describe('launchLocal', () => {
  it('AC-4: spawns --model and --effort, an override beating the environment default', async () => {
    const config = {
      delivery: {
        environments: { local: { target: 'local', model: 'sonnet' } },
      },
    };
    const plain = await launch(launchEnvironment(config));
    assert.deepEqual(plain.calls[0].args.slice(-1), ['--model=sonnet']);
    const overridden = await launch(
      launchEnvironment(config, ['model::opus', 'effort::max']),
    );
    assert.deepEqual(overridden.calls[0].args.slice(-2), [
      '--model=opus',
      '--effort=max',
    ]);
  });

  it('AC-1: spawns the default argv with {id} and a fresh session id, and records that id', async () => {
    const { record, calls, made } = await launch(launchEnvironment());
    const argv = [
      'claude',
      '-p',
      '/mandrel-deliver 42',
      '--session-id',
      'sess-1',
      '--name',
      '◐ Delivery #42',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'claude');
    assert.deepEqual(calls[0].args, argv.slice(1));
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
      argv,
      sessionId: 'sess-1',
    });
  });

  it('AC-2: a custom command gets a fresh id only when it asks for one', async () => {
    let n = 0;
    const uuid = () => `u-${++n}`;
    const custom = (command) => ({ name: 'box', target: 'local', command });
    const asked = await launch(custom(['run', '{sessionId}', '{id}']), uuid);
    assert.deepEqual(asked.record.argv, ['run', 'u-1', '42']);
    assert.equal(asked.record.sessionId, 'u-1');
    const again = await launch(custom(['run', '{sessionId}']), uuid);
    assert.equal(again.record.sessionId, 'u-2');
    const plain = await launch(custom(['run', '{id}']), uuid);
    assert.deepEqual(plain.record.argv, ['run', '42']);
    assert.equal('sessionId' in plain.record, false);
  });
});

describe('dispatch record', () => {
  it('AC-2: reads a record written before session ids', () => {
    const tempRoot = makeTempDir('mandrel-dispatch-record-');
    try {
      const config = { project: { paths: { tempRoot } } };
      const legacy = {
        storyId: 9,
        environment: 'local',
        pid: 77,
        startedAt: '2026-11-01T00:00:00.000Z',
        logPath: path.join(tempRoot, 'dispatch', 'story-9.log'),
        argv: ['claude', '-p', '/mandrel-deliver 9'],
      };
      fs.mkdirSync(path.join(tempRoot, 'dispatch'), { recursive: true });
      writeRecord(legacy, { config });
      assert.deepEqual(readRecord(9, { config }), legacy);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
