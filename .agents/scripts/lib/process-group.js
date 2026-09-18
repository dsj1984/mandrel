/**
 * process-group.js — own a spawned child as a whole process group (Story #5377).
 *
 * Killing `npm` is not killing the suite. `npm test` forks `node --test`,
 * which forks up to one worker per core, and a plain `child.kill()` reaches
 * only the first of those. The rest outlive the kill, keep their cores busy,
 * and load the host the next suite runs on. So every child spawned through
 * this module is the leader of its own process group, and every kill here —
 * timeout, abort, a signal to the parent — is delivered to the group.
 *
 * **Signal forwarding.** While any supervised child is alive, a
 * SIGINT/SIGTERM to this process first takes those children down, then lets
 * the signal do what it was going to do. The handler is *prepended* so it
 * runs before the full-suite lock's own release-and-re-raise handler: the
 * suite dies before the lock is released, never after the process has gone.
 * A group leader is `setsid`, so it no longer receives the terminal's Ctrl-C
 * on its own — this forwarding is the only thing that reaches it.
 *
 * **win32.** There are no POSIX process groups there, so a group kill
 * degrades to the plain child kill. Nothing on the kill path may throw: a
 * child that is already gone is the outcome the kill wanted.
 */

/** Exit code a supervised child reports when its wall-clock budget tripped. */
export const TIMEOUT_EXIT_CODE = 124;

const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * The spawn options that make a child the leader of its own process group.
 * `detached` on win32 opens a new console instead, so it is POSIX-only.
 *
 * @param {string} [platform]
 * @returns {{ detached?: boolean }}
 */
export function groupSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? {} : { detached: true };
}

/**
 * Deliver `signal` to the child's whole process group, falling back to the
 * child alone (win32, or a group that no longer exists). Never throws.
 *
 * @param {{ pid?: number, kill?: (signal?: string) => void }} child
 * @param {string} [signal]
 * @param {{ platform?: string, killFn?: (pid: number, signal: string) => void }} [opts]
 * @returns {boolean} Whether any kill was delivered.
 */
function killProcessGroup(
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
 * Kill every supervised group, then let the signal proceed. When another
 * listener remains (the full-suite lock's release handler) it runs next and
 * re-raises; when none does, this handler re-raises itself so the process
 * still dies the way it was asked to.
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
 * Supervise a spawned group leader: kill its group when `timeoutMs` elapses
 * (reported through `timedOut`), when `abortSignal` fires, or when this
 * process takes SIGINT/SIGTERM. Call `release()` once the child has exited.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{
 *   timeoutMs?: number,
 *   abortSignal?: AbortSignal,
 *   signalOnParentSignal?: string,
 *   processImpl?: NodeJS.Process,
 *   killOptions?: { platform?: string, killFn?: Function },
 * }} [opts] `signalOnParentSignal` is what the group receives when this
 *   process is signalled: SIGKILL for a bare suite, SIGTERM for a child that
 *   has its own cleanup to run (a capture holding the lock). `killOptions`
 *   is a test seam for the platform and the kill syscall.
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
