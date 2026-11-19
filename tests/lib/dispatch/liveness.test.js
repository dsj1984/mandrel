import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processState } from '../../../.agents/scripts/lib/dispatch/liveness.js';

const STARTED = '2026-11-18T00:00:00.000Z';
const local = { storyId: 7, pid: 4321, startedAt: STARTED };
const failWith = (code) => () => {
  throw Object.assign(new Error(code), { code });
};

describe('processState (AC-3)', () => {
  it('is working when signal 0 reaches the pid, and sends nothing else', () => {
    const sent = [];
    const kill = (pid, signal) => sent.push([pid, signal]);
    assert.deepEqual(processState(local, { kill }), {
      state: 'working',
      startedAt: STARTED,
    });
    assert.deepEqual(sent, [[4321, 0]]);
  });

  it('is working when the pid exists but belongs to another user', () => {
    assert.equal(
      processState(local, { kill: failWith('EPERM') }).state,
      'working',
    );
  });

  it('is exited when no such process exists', () => {
    assert.deepEqual(processState(local, { kill: failWith('ESRCH') }), {
      state: 'exited',
      startedAt: STARTED,
    });
  });

  it('is unknown for a cloud record, no record, no pid or another failure', () => {
    const kill = () => assert.fail('must not probe');
    const cloud = { storyId: 7, startedAt: STARTED, sessionUrl: 'https://x' };
    assert.deepEqual(processState(cloud, { kill }), {
      state: 'unknown',
      startedAt: STARTED,
    });
    assert.deepEqual(processState(null, { kill }), {
      state: 'unknown',
      startedAt: null,
    });
    assert.equal(processState({ storyId: 7 }, { kill }).state, 'unknown');
    assert.equal(
      processState(local, { kill: failWith('EINVAL') }).state,
      'unknown',
    );
  });

  it('probes the real process table by default', () => {
    assert.equal(
      processState({ storyId: 1, pid: process.pid }).state,
      'working',
    );
  });
});
