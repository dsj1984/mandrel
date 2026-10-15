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
