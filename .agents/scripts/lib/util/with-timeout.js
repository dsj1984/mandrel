/**
 * Race `input` against a timeout that rejects with `code === 'ETIMEDOUT'`.
 * The timer is cleared on every settle, so none leaks.
 *
 * @template T
 * @param {Promise<T> | T} input
 * @param {number} ms - Timeout in milliseconds. Must be a non-negative integer.
 * @param {{ label?: string }} [opts] - `label` is embedded in the timeout message.
 * @returns {Promise<T>}
 */
export function withTimeout(input, ms, { label = 'operation' } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms} ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(input), timeout]).finally(() => {
    clearTimeout(timer);
  });
}
