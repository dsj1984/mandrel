/**
 * lib/cpu-pool.js — Generic worker_threads pool for CPU-bound work.
 *
 * `runOnPool(workerScript, items, opts)` spawns up to
 * `opts.concurrency ?? os.availableParallelism()` persistent workers,
 * dispatches `items` to whichever worker is idle, and resolves with an
 * array of per-item results in input order. The queue is bounded by
 * worker count — we only have N items in flight at once, where N =
 * concurrency, so back-pressure is implicit.
 *
 * Determinism:
 *   - The returned `results` array is indexed by input position. Workers
 *     race on dispatch but each result lands at its source index, so
 *     callers that need deterministic output order can either consume
 *     `results` directly (already in input order) or apply a stable
 *     sort by file path / id of their choosing after the pool drains.
 *
 * Failure handling:
 *   - The worker contract is: emit `{ ok: true, result }` per item, or
 *     `{ ok: false, error: string }` for a per-item failure. The default
 *     is to capture per-item failures as `{ __cpuPoolError: true,
 *     message }` entries at the corresponding result index so one bad
 *     input does not abort the run. Pass `opts.throwOnItemError === true`
 *     (an explicit `true`, not just truthy) to flip to the abort-on-first
 *     mode, which rejects the whole `runOnPool` call.
 *   - A worker that crashes (`error` event) or exits non-zero rejects
 *     the whole pool — that is not a per-item failure, it is a host-level
 *     fault and must surface.
 *
 * Worker-side contract:
 *   - The worker entry receives `workerData` (passed once at spawn).
 *   - It listens on `parentPort` for messages of shape `{ item }` for
 *     work dispatch, or `{ exit: true }` to drain and exit cleanly.
 *   - It must `parentPort.postMessage({ ok, result | error })` exactly
 *     once per `{ item }` it receives.
 *
 * No project config or git access is loaded here — the pool itself is
 * a thin scheduler so workers stay cheap to spawn.
 *
 * Worker injection (testability):
 *   - The worker handle is produced by `opts.workerFactory(script, options)`,
 *     defaulting to `(script, options) => new Worker(script, options)`. The
 *     factory must return an EventEmitter-shaped handle exposing the subset
 *     of the `worker_threads.Worker` surface the scheduler uses: `on`,
 *     `off`, `once`, `postMessage`, and a thenable `terminate()`. Injecting
 *     a synchronous fake factory lets unit tests drive the scheduling,
 *     ordering, and exit-race branches in-process without spawning a real
 *     OS thread.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';

/** Default factory: spawn a real `worker_threads.Worker`. */
const defaultWorkerFactory = (script, options) => new Worker(script, options);

/**
 * Pool-vs-serial cutover for `runOnPool` callers.
 *
 * Below this batch size the pool's worker spawn overhead dominates, so
 * callers fall back to in-process serial scoring. Tuned against the test
 * suite's tmpdir fixtures (n=2 stays serial; the full repo n≈200–470
 * takes the pool path). Single-sourced here so the maintainability
 * baseline scan (`maintainability-utils.js`), the CRAP scanner
 * (`crap-utils.js`), and the native review provider
 * (`review-providers/native.js`) cannot silently desynchronize on a
 * retune.
 */
export const POOL_SERIAL_THRESHOLD = 8;

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

  const requested = opts.concurrency ?? os.availableParallelism();
  const concurrency = Math.max(1, Math.min(requested, itemsArr.length));
  const workerData = opts.workerData;
  const throwOnItemError = opts.throwOnItemError === true;
  const workerFactory = opts.workerFactory ?? defaultWorkerFactory;

  const results = new Array(itemsArr.length);
  let nextIndex = 0;
  let firstFatalError = null;

  async function runWorker() {
    const worker = workerFactory(workerScript, { workerData });
    // Track exit at worker scope so the finally block can short-circuit
    // when the worker has already gone away (e.g. mid-dispatch
    // process.exit). Registering a single persistent listener here also
    // sidesteps the race where worker.once('exit', ...) added inside
    // finally arrives after the 'exit' event has already fired and
    // therefore never resolves.
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
        // Wait briefly for clean exit, then force-terminate. Re-check
        // workerExited because the dispatch loop may have observed the
        // exit between the guard above and here.
        if (!workerExited) {
          const exited = new Promise((resolve) => {
            if (workerExited) resolve();
            else worker.once('exit', resolve);
          });
          // Do NOT .unref() the fallback timer: an unrefed timer lets
          // the event loop appear idle while this promise is pending,
          // which trips Node's test runner cancellation under cold-CI
          // conditions.
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

/**
 * Round-trip a single item through `worker`, resolving to a tagged
 * outcome. Never throws: a host-level fault is reported as
 * `{ kind: 'fatal', error }` so `runOnPool` can record it as the first
 * fatal error and stop dispatching.
 */
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
