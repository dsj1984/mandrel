/**
 * pollUntil — run `fn` every `intervalMs` until `predicate(result)` holds
 * (returns it), `signal` aborts (`undefined`), or `timeoutMs` elapses
 * (throws). A throwing `fn` is logged and treated as a non-match, so one
 * transient error never ends the poll. `sleepFn(ms, signal)` lets a caller
 * keep its own delay seam.
 */

/**
 * @param {{
 *   fn: () => any | Promise<any>,
 *   predicate: (result: any) => boolean,
 *   intervalMs: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   logger?: { warn?: Function },
 *   sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} opts
 * @returns {Promise<any | undefined>}
 */
export async function pollUntil(opts) {
  const {
    fn,
    predicate,
    intervalMs,
    timeoutMs,
    signal,
    logger,
    sleepFn = sleep,
  } = opts;
  if (typeof fn !== 'function') throw new TypeError('pollUntil: fn required');
  if (typeof predicate !== 'function') {
    throw new TypeError('pollUntil: predicate required');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new TypeError('pollUntil: intervalMs must be a non-negative number');
  }

  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;

  while (!signal?.aborted) {
    let result;
    let errored = false;
    try {
      result = await fn();
    } catch (err) {
      errored = true;
      logger?.warn?.(`[pollUntil] fn error: ${err?.message ?? err}`);
    }
    if (!errored && predicate(result)) return result;
    if (deadline !== null && Date.now() >= deadline) {
      throw new Error(`pollUntil: timed out after ${timeoutMs}ms`);
    }
    await sleepFn(intervalMs, signal);
  }
  return undefined;
}

/**
 * Resolves after `ms` or on abort. Deliberately not `unref`'d: Node 22's test
 * runner cancels subtests awaiting an unref'd timer. Abort the signal for a
 * clean shutdown instead.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
