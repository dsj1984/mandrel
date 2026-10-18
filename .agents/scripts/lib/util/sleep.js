/**
 * The one default `sleep` seam modules inject-and-override in tests.
 *
 * @module lib/util/sleep
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Blocks without spinning; a no-op for a non-finite or non-positive `ms`. */
export function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
