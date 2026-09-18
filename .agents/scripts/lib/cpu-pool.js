/**
 * worker_threads pool for CPU-bound work; results land in input order.
 *
 * Worker contract: receives `workerData` once; handles `{ item }` by posting
 * exactly one `{ ok: true, result }` or `{ ok: false, error }`, and
 * `{ exit: true }` by exiting. A per-item error becomes a `__cpuPoolError`
 * entry (or rejects with `throwOnItemError === true`); a crash or non-zero
 * exit rejects the whole pool.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';

const defaultWorkerFactory = (script, options) => new Worker(script, options);

/**
 * Batch size below which callers score serially: measured serial/pooled
 * crossover lies between 256 and 384 files. Output is identical either way.
 * Shared by every pooled scanner so they cannot desynchronize.
 */
export const POOL_SERIAL_THRESHOLD = 256;

/**
 * Under `node:test` the runner already fans out across processes; an
 * unclamped pool in each would oversubscribe the host.
 */
const NODE_TEST_CONCURRENCY_CLAMP = 4;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function inNodeTestContext(env) {
  return (
    typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT !== ''
  );
}

/**
 * Explicit option, then `MANDREL_POOL_CONCURRENCY`, then the `node:test`
 * clamp, then available parallelism. Non-positive values fall through.
 *
 * @param {number|undefined} explicit
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function resolvePoolConcurrency(explicit, env = process.env) {
  const positive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  };
  return (
    positive(explicit) ??
    positive(env.MANDREL_POOL_CONCURRENCY) ??
    (inNodeTestContext(env) ? NODE_TEST_CONCURRENCY_CLAMP : null) ??
    os.availableParallelism()
  );
}

/**
 * @template TItem, TResult
 * @param {string|URL} workerScript - File URL or path to the worker entry.
 * @param {TItem[]} items
 * @param {{
 *   concurrency?: number,
 *   workerData?: unknown,
 *   throwOnItemError?: boolean,
 *   workerFactory?: (
 *     script: string|URL,
 *     options: { workerData?: unknown },
 *   ) => import('node:events').EventEmitter & {
 *     postMessage: (msg: unknown) => void,
 *     terminate: () => Promise<unknown> | unknown,
 *   },
 * }} [opts]
 * @returns {Promise<Array<TResult | { __cpuPoolError: true, message: string }>>}
 */
export async function runOnPool(workerScript, items, opts = {}) {
  const itemsArr = [...items];
  if (itemsArr.length === 0) return [];

  const requested = resolvePoolConcurrency(opts.concurrency);
  const concurrency = Math.max(1, Math.min(requested, itemsArr.length));
  const workerData = opts.workerData;
  const throwOnItemError = opts.throwOnItemError === true;
  const workerFactory = opts.workerFactory ?? defaultWorkerFactory;

  const results = new Array(itemsArr.length);
  let nextIndex = 0;
  let firstFatalError = null;

  async function runWorker() {
    const worker = workerFactory(workerScript, { workerData });
    // A persistent listener: a once('exit') added in `finally` could miss an
    // exit that already fired and never resolve.
    let workerExited = false;
    worker.on('exit', () => {
      workerExited = true;
    });
    try {
      while (firstFatalError === null) {
        const myIndex = nextIndex++;
        if (myIndex >= itemsArr.length) break;
        const item = itemsArr[myIndex];
        // eslint-disable-next-line no-await-in-loop
        const outcome = await dispatchOne(worker, item);
        if (outcome.kind === 'ok') {
          results[myIndex] = outcome.result;
        } else if (outcome.kind === 'item-error') {
          if (throwOnItemError) {
            firstFatalError = new Error(
              `cpu-pool item failure: ${outcome.message}`,
            );
            break;
          }
          results[myIndex] = {
            __cpuPoolError: true,
            message: outcome.message,
          };
        } else {
          // host-level fault: worker crashed or emitted bad shape.
          if (firstFatalError === null) firstFatalError = outcome.error;
          break;
        }
      }
    } finally {
      if (!workerExited) {
        try {
          worker.postMessage({ exit: true });
        } catch {
          // worker may already be terminating
        }
        if (!workerExited) {
          const exited = new Promise((resolve) => {
            if (workerExited) resolve();
            else worker.once('exit', resolve);
          });
          // Never unref: an idle-looking loop trips test-runner cancellation.
          await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        }
      }
      try {
        await worker.terminate();
      } catch {
        // already gone
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

  if (firstFatalError !== null) throw firstFatalError;
  return results;
}

/** Never throws; a host-level fault resolves `{ kind: 'fatal', error }`. */
function dispatchOne(worker, item) {
  return new Promise((resolve) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (msg) => {
      cleanup();
      if (msg && msg.ok === true) {
        resolve({ kind: 'ok', result: msg.result });
        return;
      }
      if (msg && msg.ok === false) {
        resolve({
          kind: 'item-error',
          message: typeof msg.error === 'string' ? msg.error : 'unknown',
        });
        return;
      }
      resolve({
        kind: 'fatal',
        error: new Error(
          `cpu-pool: malformed worker message: ${JSON.stringify(msg)}`,
        ),
      });
    };
    const onError = (err) => {
      cleanup();
      resolve({ kind: 'fatal', error: err });
    };
    const onExit = (code) => {
      cleanup();
      if (code !== 0) {
        resolve({
          kind: 'fatal',
          error: new Error(`cpu-pool: worker exited with code ${code}`),
        });
        return;
      }
      // Clean exit mid-dispatch: treat as fatal so the item is not silently lost.
      resolve({
        kind: 'fatal',
        error: new Error('cpu-pool: worker exited mid-dispatch'),
      });
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage({ item });
  });
}
