/**
 * Extra cpu-pool tests covering branches the parity / error-isolation
 * suite doesn't reach: empty items short-circuit, throwOnItemError
 * fatal path, and the onError / onExit branches inside dispatchOne.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runOnPool } from '../../.agents/scripts/lib/cpu-pool.js';

function workerOf(source) {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

describe('runOnPool — short-circuits and config edges', () => {
  it('returns [] immediately when items is empty', async () => {
    const result = await runOnPool(
      workerOf("import { parentPort } from 'node:worker_threads';"),
      [],
      { concurrency: 4 },
    );
    assert.deepEqual(result, []);
  });

  it('uses os.availableParallelism when concurrency is unspecified', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) parentPort.close();
        else parentPort.postMessage({ ok: true, result: msg.item * 2 });
      });
    `);
    const results = await runOnPool(workerUrl, [1, 2, 3]);
    assert.deepEqual(results, [2, 4, 6]);
  });

  it('clamps concurrency to items.length when caller asks for more', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) parentPort.close();
        else parentPort.postMessage({ ok: true, result: msg.item });
      });
    `);
    const results = await runOnPool(workerUrl, [1, 2], { concurrency: 16 });
    assert.deepEqual(results, [1, 2]);
  });
});

describe('runOnPool — fatal-error fan-out', () => {
  it('throwOnItemError=true rejects the run on the first per-item failure', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) { parentPort.close(); return; }
        if (msg.item === 'bad') {
          parentPort.postMessage({ ok: false, error: 'no good' });
          return;
        }
        parentPort.postMessage({ ok: true, result: msg.item });
      });
    `);
    await assert.rejects(
      () =>
        runOnPool(workerUrl, ['a', 'bad', 'c'], {
          concurrency: 1,
          throwOnItemError: true,
        }),
      /cpu-pool item failure: no good/,
    );
  });

  it('onMessage with malformed envelope flips the run to fatal', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) { parentPort.close(); return; }
        // Neither {ok:true} nor {ok:false}; parent should treat as malformed.
        parentPort.postMessage({ unexpected: msg.item });
      });
    `);
    await assert.rejects(
      () => runOnPool(workerUrl, ['x'], { concurrency: 1 }),
      /malformed worker message/,
    );
  });

  it('worker crash (uncaught throw) surfaces as a host-level fault', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) { parentPort.close(); return; }
        // Synchronously throw before posting → emits an 'error' event.
        throw new Error('worker boom');
      });
    `);
    await assert.rejects(
      () => runOnPool(workerUrl, ['x'], { concurrency: 1 }),
      /worker boom/,
    );
  });

  it('worker exits mid-dispatch with non-zero status → fatal "exited with code"', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) { parentPort.close(); return; }
        process.exit(7);
      });
    `);
    await assert.rejects(
      () => runOnPool(workerUrl, ['x'], { concurrency: 1 }),
      /exited with code 7/,
    );
  });

  it('worker exits with code 0 mid-dispatch → fatal "exited mid-dispatch"', async () => {
    const workerUrl = workerOf(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg && msg.exit === true) { parentPort.close(); return; }
        process.exit(0);
      });
    `);
    await assert.rejects(
      () => runOnPool(workerUrl, ['x'], { concurrency: 1 }),
      /exited mid-dispatch/,
    );
  });
});
