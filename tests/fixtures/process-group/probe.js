/**
 * Shared helpers for the process-group tests (Story #5377): wait for a file,
 * wait for a child to exit, and ask whether a pid is still alive.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

/** The `ps` stat column for `pid`, or '' when `ps` lists no such process. */
function psStat(pid) {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Where `pid` is: `gone`, `zombie` (dead, not yet reaped) or `alive`.
 * `kill(pid, 0)` succeeds on a zombie, and an orphaned worker can wait
 * seconds for init to reap it under load — so POSIX asks `ps` for the stat.
 *
 * @param {number} pid
 * @returns {{ state: 'gone' | 'zombie' | 'alive', stat: string }}
 */
export function pidState(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return { state: 'gone', stat: '' };
  }
  if (process.platform === 'win32') return { state: 'alive', stat: '' };
  const stat = psStat(pid);
  if (stat === '') return { state: 'gone', stat };
  return { state: stat.startsWith('Z') ? 'zombie' : 'alive', stat };
}

/**
 * Assert `pid` stops executing within `timeoutMs`. A zombie has already died
 * of its signal, so it counts as gone; on timeout the message names what the
 * probe last saw.
 */
export async function assertGone(pid, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = pidState(pid);
  while (seen.state === 'alive' && Date.now() < deadline) {
    await sleep(25);
    seen = pidState(pid);
  }
  assert.notEqual(
    seen.state,
    'alive',
    `${message}: pid ${pid} still alive after ${timeoutMs}ms (ps stat: ${seen.stat || 'n/a'})`,
  );
}

/** Resolve `{ code, signal, ms }` when `child` exits. */
export function waitForExit(child, startedAt = Date.now()) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) =>
      resolve({ code, signal, ms: Date.now() - startedAt }),
    );
  });
}
