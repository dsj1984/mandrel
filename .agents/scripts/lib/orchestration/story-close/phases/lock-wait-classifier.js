/**
 * lock-wait-classifier.js — windowed CPU sampling + freshness-aware
 * classifier for lock-contention recovery.
 *
 * Background: Epic #2453 / Story #2462 observed a false-positive in the
 * lock-wait recovery path where a healthy holder process was misclassified
 * as `stale` because the recovery code took a single instantaneous CPU
 * sample. A holder that happened to be between scheduler quanta — or had
 * just started and not yet accumulated measurable CPU time — looked
 * identical to a hung holder.
 *
 * This module replaces that instantaneous probe with two complementary
 * signals:
 *
 *   1. **Windowed CPU sampling.** `sampleCpuOverWindow(pid, opts)` polls
 *      total accumulated CPU time across a window (default 45 s, 5 s
 *      cadence) and returns the delta. Any non-trivial delta proves the
 *      holder did real work during the observation window.
 *
 *   2. **Freshness gate.** `processStartTime(pid)` reports the process
 *      start instant. `classifyLockHolder` refuses a `stale` verdict for
 *      holders started within the last 5 minutes — a just-spawned holder
 *      that has not yet logged CPU time is treated as `live`, not as a
 *      stuck process to be evicted.
 *
 * Cross-platform: Windows uses `Get-Process` (`TotalProcessorTime`,
 * `StartTime`); POSIX reads `/proc/<pid>/stat` (fields 14+15 for utime/
 * stime in clock ticks, field 22 for starttime in clock ticks since boot)
 * combined with `/proc/uptime`.
 *
 * Side-effect-free apart from spawning the platform probe. Callers
 * needing fully deterministic tests inject the `probeCpuMs` /
 * `probeStartTime` / `now` / `sleep` helpers via `opts`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const DEFAULT_WINDOW_MS = 45_000;
const DEFAULT_INTERVAL_MS = 5_000;
const FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000;
// CPU-time deltas below this are noise (process bookkeeping, signal
// handling) — not evidence of useful forward progress.
const CPU_PROGRESS_FLOOR_MS = 50;

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Read accumulated CPU time (milliseconds, user + kernel) for a PID.
 * Returns `null` if the process does not exist or the probe fails.
 *
 * @param {number} pid
 * @returns {number | null}
 */
export function readCpuMs(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (isWindows()) return readCpuMsWindows(pid);
  return readCpuMsPosix(pid);
}

function readCpuMsWindows(pid) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const ms = Number(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function readCpuMsPosix(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 is `(comm)` which may contain spaces — split past the
    // trailing `)` to get a stable index for fields 3+.
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const after = raw.slice(closeParen + 1).trim().split(/\s+/);
    // After the close paren, indices shift by 3 (1=pid, 2=comm, 3=state →
    // after[0]). utime=field14 → after[11]; stime=field15 → after[12].
    const utime = Number(after[11]);
    const stime = Number(after[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    const ticks = utime + stime;
    const hz = clockTicksPerSecond();
    return (ticks / hz) * 1000;
  } catch {
    return null;
  }
}

let cachedHz = null;
function clockTicksPerSecond() {
  if (cachedHz != null) return cachedHz;
  // POSIX systems expose `getconf CLK_TCK`. Fall back to 100, the kernel
  // default on every Linux distro shipped since the 2.6 series.
  try {
    const out = execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const hz = Number(out);
    cachedHz = Number.isFinite(hz) && hz > 0 ? hz : 100;
  } catch {
    cachedHz = 100;
  }
  return cachedHz;
}

/**
 * Read the start time of a PID as a Unix epoch in milliseconds.
 * Returns `null` if the process does not exist or the probe fails.
 *
 * @param {number} pid
 * @returns {number | null}
 */
export function processStartTime(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (isWindows()) return processStartTimeWindows(pid);
  return processStartTimePosix(pid);
}

function processStartTimeWindows(pid) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[int64](([datetimeoffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds())`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const ms = Number(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function processStartTimePosix(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const after = raw.slice(closeParen + 1).trim().split(/\s+/);
    // starttime = field 22 → after[19]: clock ticks since boot.
    const startTicks = Number(after[19]);
    if (!Number.isFinite(startTicks)) return null;
    const uptimeRaw = fs.readFileSync('/proc/uptime', 'utf8').trim();
    const uptimeSeconds = Number(uptimeRaw.split(/\s+/)[0]);
    if (!Number.isFinite(uptimeSeconds)) return null;
    const bootTimeMs = Date.now() - Math.round(uptimeSeconds * 1000);
    const startOffsetMs = (startTicks / clockTicksPerSecond()) * 1000;
    return bootTimeMs + startOffsetMs;
  } catch {
    return null;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sample accumulated CPU time across a window. Returns the delta
 * (milliseconds) between the first and last successful samples, plus
 * metadata describing how the window resolved.
 *
 * @param {number} pid
 * @param {{
 *   windowMs?: number,
 *   intervalMs?: number,
 *   probeCpuMs?: (pid: number) => number | null,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<{ deltaMs: number | null, samples: number, firstMs: number | null, lastMs: number | null }>}
 */
export async function sampleCpuOverWindow(pid, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const probe = opts.probeCpuMs ?? readCpuMs;
  const sleep = opts.sleep ?? defaultSleep;

  const ticks = Math.max(2, Math.floor(windowMs / intervalMs) + 1);
  let firstMs = null;
  let lastMs = null;
  let samples = 0;

  for (let i = 0; i < ticks; i += 1) {
    const value = probe(pid);
    if (Number.isFinite(value)) {
      samples += 1;
      if (firstMs == null) firstMs = value;
      lastMs = value;
    }
    if (i < ticks - 1) await sleep(intervalMs);
  }

  const deltaMs =
    firstMs != null && lastMs != null ? Math.max(0, lastMs - firstMs) : null;
  return { deltaMs, samples, firstMs, lastMs };
}

/**
 * Classify a lock-holder process as `live`, `stale`, or `unknown`.
 *
 * Decision order:
 *   1. **Liveness probe.** If `process.kill(pid, 0)` (or the injected
 *      equivalent) reports the PID is dead, return `stale` immediately —
 *      no need to spend a 45 s window sampling a corpse.
 *   2. **Freshness gate.** If the holder's `processStartTime` is within
 *      `freshnessMs` (default 5 minutes), return `live`. Just-spawned
 *      holders that have not yet accumulated measurable CPU are NOT
 *      candidates for stale-eviction — this is the false-positive that
 *      motivated the Story.
 *   3. **Windowed sample.** Otherwise, sample CPU across the window. A
 *      delta above `progressFloorMs` (default 50 ms) is `live`; zero
 *      progress is `stale`.
 *   4. **Unknown.** If the windowed probe never returned a sample (e.g.
 *      the process died mid-window or the probe is unavailable on this
 *      platform), return `unknown` so the caller can fall back to its
 *      existing conservative policy rather than stealing the lock.
 *
 * @param {number} pid
 * @param {{
 *   windowMs?: number,
 *   intervalMs?: number,
 *   freshnessMs?: number,
 *   progressFloorMs?: number,
 *   isAlive?: (pid: number) => boolean,
 *   probeStartTime?: (pid: number) => number | null,
 *   probeCpuMs?: (pid: number) => number | null,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} [opts]
 * @returns {Promise<{
 *   verdict: 'live' | 'stale' | 'unknown',
 *   reason: string,
 *   pid: number,
 *   ageMs: number | null,
 *   cpuDeltaMs: number | null,
 *   samples: number,
 * }>}
 */
export async function classifyLockHolder(pid, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const freshnessMs = opts.freshnessMs ?? FRESHNESS_THRESHOLD_MS;
  const progressFloorMs = opts.progressFloorMs ?? CPU_PROGRESS_FLOOR_MS;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const probeStartTime = opts.probeStartTime ?? processStartTime;
  const now = opts.now ?? Date.now;

  const base = { pid, ageMs: null, cpuDeltaMs: null, samples: 0 };

  if (!Number.isFinite(pid) || pid <= 0) {
    return { verdict: 'unknown', reason: 'invalid-pid', ...base };
  }

  if (!isAlive(pid)) {
    return { verdict: 'stale', reason: 'pid-not-running', ...base };
  }

  const startedAt = probeStartTime(pid);
  const ageMs = startedAt != null ? Math.max(0, now() - startedAt) : null;

  if (ageMs != null && ageMs < freshnessMs) {
    return {
      verdict: 'live',
      reason: 'freshness-gate',
      pid,
      ageMs,
      cpuDeltaMs: null,
      samples: 0,
    };
  }

  const sample = await sampleCpuOverWindow(pid, {
    windowMs,
    intervalMs,
    probeCpuMs: opts.probeCpuMs,
    sleep: opts.sleep,
  });

  if (sample.samples === 0) {
    return {
      verdict: 'unknown',
      reason: 'cpu-probe-unavailable',
      pid,
      ageMs,
      cpuDeltaMs: null,
      samples: 0,
    };
  }

  if ((sample.deltaMs ?? 0) >= progressFloorMs) {
    return {
      verdict: 'live',
      reason: 'cpu-progress-observed',
      pid,
      ageMs,
      cpuDeltaMs: sample.deltaMs,
      samples: sample.samples,
    };
  }

  return {
    verdict: 'stale',
    reason: 'no-cpu-progress',
    pid,
    ageMs,
    cpuDeltaMs: sample.deltaMs,
    samples: sample.samples,
  };
}

function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

