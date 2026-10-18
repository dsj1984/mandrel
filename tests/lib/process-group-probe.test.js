/**
 * The process-group probe (Story #5638): a killed-but-unreaped worker reads
 * as gone, a running one as alive, and a timeout names what it saw — so an
 * orphan waiting on init under suite load is not a false red.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  assertGone,
  pidState,
  waitForExit,
} from '../fixtures/process-group/probe.js';

/** First line of `child`'s stdout, trimmed. */
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve(buf.slice(0, nl).trim());
    });
    child.on('error', reject);
  });
}

describe('process-group probe (Story #5638)', {
  skip: process.platform === 'win32',
}, () => {
  it('a dead child nobody reaps reads as a zombie, and counts as gone', async () => {
    // The backgrounded `sleep 1` outlives the shell's `exec` into `sleep 10`,
    // which never waits, so the echoed pid dies as a zombie. A child that
    // exits before the `exec` is reaped by dash between commands and reads
    // as gone, so the background job must not finish first.
    const holder = spawn('sh', ['-c', 'sleep 1 & echo $!; exec sleep 10'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      const zombie = Number(await firstLine(holder));
      const deadline = Date.now() + 5_000;
      let seen = pidState(zombie);
      while (seen.state === 'alive' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        seen = pidState(zombie);
      }
      assert.equal(seen.state, 'zombie', `ps stat: ${seen.stat}`);
      await assertGone(zombie, 'a zombie is gone', 100);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('a running process reads as alive, and a timeout names its ps stat', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    try {
      assert.equal(pidState(child.pid).state, 'alive');
      await assert.rejects(assertGone(child.pid, 'the worker', 100), (err) => {
        assert.match(
          err.message,
          new RegExp(
            `the worker: pid ${child.pid} still alive after 100ms \\(ps stat: \\S+\\)`,
          ),
        );
        return true;
      });
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('an exited, reaped process reads as gone', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await waitForExit(child);
    assert.equal(pidState(child.pid).state, 'gone');
    await assertGone(child.pid, 'a reaped child is gone', 100);
  });
});
