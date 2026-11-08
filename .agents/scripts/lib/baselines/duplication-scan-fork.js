/**
 * Runs the duplication scan in a child with its own heap: the scan needs
 * gigabytes on a large tree, and a flag on the fork reaches nobody else.
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCAN_HEAP_MB = 4096;
const STDERR_TAIL_CHARS = 2000;
const CHILD_ENTRY = fileURLToPath(
  new URL('./duplication-scan-child.js', import.meta.url),
);

function isHeapDeath(code, signal, stderr) {
  return (
    signal === 'SIGABRT' || code === 134 || /heap out of memory/i.test(stderr)
  );
}

function childDeathError(code, signal, stderr, scanHeapMb) {
  const how = signal ? `signal ${signal}` : `exit code ${code}`;
  const hint = isHeapDeath(code, signal, stderr)
    ? ` It ran out of heap at ${scanHeapMb} MB; raise delivery.quality.gates.duplication.scanHeapMb.`
    : '';
  return new Error(
    `[Duplication] scan child died with ${how} before reporting.${hint} ${stderr.trim()}`.trim(),
  );
}

function replyError({ message, code }) {
  const err = new Error(message);
  if (code !== undefined) err.code = code;
  return err;
}

/**
 * @param {{ targetDirs: string[], cwd: string, ignoreGlobs?: string[], additionalFormats?: string[] }} scan
 * @param {{ scanHeapMb?: number, forkImpl?: typeof fork }} [opts]
 * @returns {Promise<object[]>} the scan's rows
 */
export function scanInChild(
  scan,
  { scanHeapMb = DEFAULT_SCAN_HEAP_MB, forkImpl = fork } = {},
) {
  return new Promise((resolve, reject) => {
    const child = forkImpl(CHILD_ENTRY, [], {
      execArgv: [`--max-old-space-size=${scanHeapMb}`],
      silent: true,
    });
    let reply;
    let stderr = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('message', (message) => {
      reply = message;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (reply?.error) reject(replyError(reply.error));
      else if (reply) resolve(reply.rows);
      else reject(childDeathError(code, signal, stderr, scanHeapMb));
    });
    // A failed send surfaces as the child's `close`.
    child.send(scan, () => {});
  });
}
