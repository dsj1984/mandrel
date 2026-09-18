/**
 * Shared helpers for the process-group tests (Story #5377): wait for a file,
 * wait for a child to exit, and ask whether a pid is still alive.
 */
import fs from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once `file` exists and is non-empty, or reject after `timeoutMs`. */
export async function waitForFile(file, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').length > 0) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${file}`);
}

/** Is `pid` a live process? A zombie reaped by init reads dead soon after. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

/** Poll until `pid` is gone; resolve whether it went within `timeoutMs`. */
export async function waitForDeath(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

/** Resolve `{ code, signal, ms }` when `child` exits. */
export function waitForExit(child, startedAt = Date.now()) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) =>
      resolve({ code, signal, ms: Date.now() - startedAt }),
    );
  });
}
