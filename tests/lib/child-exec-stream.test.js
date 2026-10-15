/**
 * child-exec-stream.test.js — the streamed runner (Story #5694). Real `node -e`
 * children: chunks arrive in order while the child runs, only a bounded tail
 * is retained, and a timeout or abort kills the child and still settles.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnStreamAsync } from '../../.agents/scripts/lib/child-exec.js';

const NODE = process.execPath;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnStreamAsync', () => {
  it('streams stdout and stderr chunks and settles with the trimmed tails', async () => {
    const chunks = [];
    const res = await spawnStreamAsync(
      NODE,
      [
        '-e',
        'process.stdout.write("out-1\\n"); process.stderr.write("err-1\\n"); process.stdout.write("out-2\\n");',
      ],
      { onChunk: (text, stream) => chunks.push({ text, stream }) },
    );
    assert.equal(res.status, 0);
    assert.equal(res.timedOut, false);
    assert.equal(res.stdout, 'out-1\nout-2');
    assert.equal(res.stderr, 'err-1');
    const streamed = chunks.map((c) => c.text).join('');
    for (const marker of ['out-1', 'err-1', 'out-2']) {
      assert.ok(streamed.includes(marker), `${marker} streamed`);
    }
    assert.ok(chunks.some((c) => c.stream === 'stderr'));
  });

  it('reports a non-zero exit status verbatim', async () => {
    const res = await spawnStreamAsync(NODE, [
      '-e',
      'console.log("bye"); process.exit(3);',
    ]);
    assert.equal(res.status, 3);
    assert.equal(res.stdout, 'bye');
  });

  it('retains only the bounded tail while onChunk sees every byte', async () => {
    let streamedBytes = 0;
    const res = await spawnStreamAsync(
      NODE,
      [
        '-e',
        'for (let i = 0; i < 2000; i += 1) process.stdout.write("x".repeat(99) + "\\n"); process.stdout.write("LAST");',
      ],
      {
        tailBytes: 1024,
        onChunk: (text) => {
          streamedBytes += Buffer.byteLength(text);
        },
      },
    );
    assert.equal(res.status, 0);
    assert.equal(streamedBytes, 2000 * 100 + 4);
    assert.ok(res.stdout.length <= 1024, 'tail is bounded');
    assert.ok(res.stdout.endsWith('LAST'), 'the tail keeps the newest bytes');
  });

  it('kills a child that outlives timeoutMs and normalises the status to non-zero', async () => {
    const started = Date.now();
    const res = await spawnStreamAsync(
      NODE,
      ['-e', 'console.log("A"); setInterval(() => {}, 1000);'],
      { timeoutMs: 300 },
    );
    assert.equal(res.timedOut, true);
    assert.equal(res.status, 124);
    assert.equal(res.stdout, 'A');
    assert.ok(Date.now() - started < 5000, 'settles promptly');
    assert.equal(isAlive(res.pid), false, 'the child is gone');
  });

  it('kills the child when the abort signal fires', async () => {
    const controller = new AbortController();
    const res = await spawnStreamAsync(
      NODE,
      ['-e', 'console.log("A"); setInterval(() => {}, 1000);'],
      {
        signal: controller.signal,
        onChunk: () => controller.abort(),
      },
    );
    assert.notEqual(res.status, 0);
    assert.equal(res.timedOut, false);
    assert.equal(isAlive(res.pid), false, 'the child is gone');
  });

  it('a missing binary resolves status 1 with the spawn error', async () => {
    const res = await spawnStreamAsync('definitely-not-a-binary-5694', []);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ENOENT/);
  });

  it('a throwing onChunk does not break the run', async () => {
    const res = await spawnStreamAsync(NODE, ['-e', 'console.log("ok")'], {
      onChunk: () => {
        throw new Error('sink down');
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, 'ok');
  });
});
