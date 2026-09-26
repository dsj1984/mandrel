/**
 * process-group.js — kill spawned children as whole process groups:
 * `child.kill()` on `npm` misses the `node --test` workers it forks.
 * Parent SIGINT/SIGTERM is forwarded by a prepended handler, so the suite
 * dies before the lock's release handler runs (a `setsid` leader never gets
 * the terminal's Ctrl-C). win32 has no groups and degrades to the child.
 * The kill path never throws.
 */

export const TIMEOUT_EXIT_CODE = 124;

const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * `detached` on win32 opens a new console instead.
 *
 * @param {string} [platform]
 * @returns {{ detached?: boolean }}
 */
export function groupSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? {} : { detached: true };
}

/**
 * @param {{ pid?: number, kill?: (signal?: string) => void }} child
 * @param {string} [signal]
 * @param {{ platform?: string, killFn?: (pid: number, signal: string) => void }} [opts]
 * @returns {boolean}
 */
export function killProcessGroup(
  child,
  signal = 'SIGKILL',
  { platform = process.platform, killFn = process.kill.bind(process) } = {},
) {
  const pid = child?.pid;
  if (platform !== 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      killFn(-pid, signal);
      return true;
    } catch {
      // The group is gone (or was never ours) — try the child itself.
    }
  }
  try {
    child?.kill?.(signal);
    return true;
  } catch {
    return false;
  }
}

/** child → the signal its group receives when this process is signalled. */
const supervised = new Map();
let detachForwarding = null;

/**
 * A remaining listener (the lock's release handler) re-raises; with none,
 * re-raise here so the process still dies as asked.
 *
 * @param {NodeJS.Process} processImpl
 * @param {string} signal
 */
function forwardSignal(processImpl, signal) {
  for (const [child, childSignal] of supervised) {
    killProcessGroup(child, childSignal);
  }
  supervised.clear();
  stopForwarding();
  if (processImpl.listenerCount(signal) > 0) return;
  try {
    processImpl.kill(processImpl.pid, signal);
  } catch {
    // A process that cannot signal itself is already on its way out.
  }
}

function startForwarding(processImpl) {
  if (detachForwarding) return;
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => forwardSignal(processImpl, signal);
    processImpl.prependListener(signal, handler);
    return [signal, handler];
  });
  detachForwarding = () => {
    for (const [signal, handler] of handlers) processImpl.off(signal, handler);
  };
}

function stopForwarding() {
  const detach = detachForwarding;
  detachForwarding = null;
  detach?.();
}

/**
 * Kill the group on timeout, abort or parent signal; `release()` on exit.
 *
 * @param {{ pid?: number, kill?: (signal?: string) => void }} child
 * @param {{
 *   timeoutMs?: number,
 *   abortSignal?: AbortSignal,
 *   signalOnParentSignal?: string,
 *   processImpl?: NodeJS.Process,
 *   killOptions?: { platform?: string, killFn?: Function },
 * }} [opts] `signalOnParentSignal`: SIGKILL for a bare suite, SIGTERM for a
 *   child with its own cleanup (a capture holding the lock).
 * @returns {{ readonly timedOut: boolean, release: () => void }}
 */
export function superviseGroup(
  child,
  {
    timeoutMs,
    abortSignal,
    signalOnParentSignal = 'SIGKILL',
    processImpl = process,
    killOptions,
  } = {},
) {
  let timedOut = false;
  supervised.set(child, signalOnParentSignal);
  startForwarding(processImpl);
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child, 'SIGKILL', killOptions);
        }, timeoutMs)
      : null;
  const onAbort = () => killProcessGroup(child, 'SIGTERM', killOptions);
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (abortSignal?.aborted) onAbort();
  return {
    get timedOut() {
      return timedOut;
    },
    release() {
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      supervised.delete(child);
      if (supervised.size === 0) stopForwarding();
    },
  };
}
