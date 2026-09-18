/**
 * Wire a pure worker message handler onto a `worker_threads` port. A falsy
 * port (module imported by a test) is a no-op.
 *
 * @param {import('node:worker_threads').MessagePort|null|undefined} port
 * @param {(msg: unknown) => {kind: 'exit'} | {kind: 'reply', message: object}} handle
 * @returns {void}
 */
export function serveWorkerMessages(port, handle) {
  if (!port) return;
  port.on('message', (msg) => {
    const out = handle(msg);
    if (out.kind === 'exit') {
      port.close();
      return;
    }
    port.postMessage(out.message);
  });
}
