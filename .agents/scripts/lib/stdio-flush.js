/**
 * Stdio drain helper. On a pipe, stdout/stderr write asynchronously once the
 * kernel buffer fills, and `process.exit()` discards the queue — a green exit
 * with a truncated envelope. CLIs set `exitCode` instead of exiting; this
 * explicitly awaits the queued bytes as the second guard.
 *
 * @module stdio-flush
 */

/**
 * Resolve once queued bytes reach the OS, via whichever of the ordered empty
 * `write()` callback or `'drain'` lands first. Resolves immediately for
 * anything not flushable — a flush must never hang a process.
 *
 * @param {NodeJS.WritableStream & { writableLength?: number, writableEnded?: boolean, destroyed?: boolean }} [stream]
 * @returns {Promise<void>}
 */
function drainStream(stream) {
  if (!stream || typeof stream.write !== 'function') return Promise.resolve();
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  if ((stream.writableLength ?? 0) === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      stream.removeListener?.('drain', done);
      resolve();
    };
    stream.once?.('drain', done);
    stream.write('', done);
  });
}

/**
 * Never rejects.
 *
 * @param {Array<NodeJS.WritableStream|undefined>} [streams]
 * @returns {Promise<void>}
 */
export async function flushStdio(streams = [process.stdout, process.stderr]) {
  await Promise.all(streams.map((stream) => drainStream(stream)));
}
