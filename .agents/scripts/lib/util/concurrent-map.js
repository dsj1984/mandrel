/**
 * concurrentMap — bounded-concurrency async map. Preserves input order; the
 * first rejection wins and stops new dispatch, while in-flight work drains
 * (no cancellation) and later rejections are swallowed.
 */

/**
 * The shared bound for independent GitHub-write fan-outs. Unbounded bursts
 * earn a secondary rate limit, not throughput; four overlaps the waits while
 * staying under it. Order-sensitive callers stay serial instead.
 */
export const FANOUT_CONCURRENCY = 4;

/**
 * @template T, R
 * @param {ReadonlyArray<T>} items
 * @param {(item: T, index: number) => Promise<R> | R} mapper
 * @param {{ concurrency?: number }} [opts]
 * @returns {Promise<R[]>}
 */
export async function concurrentMap(items, mapper, opts = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('concurrentMap: items must be an array');
  }
  if (typeof mapper !== 'function') {
    throw new TypeError('concurrentMap: mapper must be a function');
  }
  const concurrency = Number.isFinite(opts.concurrency)
    ? Math.max(1, Math.floor(opts.concurrency))
    : items.length;

  const n = items.length;
  const results = new Array(n);
  let cursor = 0;
  let firstError = null;

  async function worker() {
    while (firstError === null) {
      const idx = cursor++;
      if (idx >= n) return;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
    }
  }

  const workerCount = Math.min(concurrency, n);
  const workers = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  if (firstError !== null) throw firstError;
  return results;
}
